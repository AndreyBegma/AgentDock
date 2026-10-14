import {
  DEFAULT_VIEWPORTS,
  DESIGN_COMMENTS_PER_TURN_MAX,
  DESIGN_ERROR,
  type DesignCommentRequest,
  PLANNER_ERROR,
  type TaskDesignPatchRequest,
  type TaskDesignView,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import type { Plan, PlanTask, TaskDesign } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { callerOf, type PlanActor } from '../planner/plan.service';
import { blockingOpen, questionsOf } from '../planner/plan-mapper';
import { PlanStore } from '../planner/plan-store';
import { type PlanCaller, PlanTurnService } from '../planner/plan-turn.service';
import { plannerError } from '../planner/planner-error';
import { settleDesign } from './design-apply';
import { designError } from './design-error';
import {
  designInclude,
  skillWarnings,
  toDesignView,
  viewportsOf,
} from './design-mapper';
import { batchOf, type DesignTurnPlan, withDesign } from './design-rules';
import { defaultSkillsOf, installedOf } from './design-store';
import { UiProfileService } from './ui-profile.service';
import type { WaitingDesign } from './ui-profile-mapper';

/** A design with a turn or a profile build of it queued or running. */
const BUSY = ['generating', 'revising'] as const;

/** Task statuses that settle a task: its design no longer changes (D2). */
const SETTLED = ['approved', 'rejected', 'issued'] as const;

const isBusy = (design: Pick<TaskDesign, 'status'>): boolean =>
  (BUSY as readonly string[]).includes(design.status);

const busy = () =>
  designError(
    409,
    DESIGN_ERROR.designBusy,
    'A design turn or a profile build of this design is queued or running',
  );

/**
 * A task's design (docs/specs/223-design-stage.md D1–D4, D8–D11, D15, D17):
 * the switch, the variant count and skills, Generate, comments, Revise and
 * Approve. Turns are the planner's (`PlanTurnService`); the profile is
 * checked and built first (`UiProfileService`, D13).
 */
@Injectable()
export class DesignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: PlanStore,
    private readonly turns: PlanTurnService,
    private readonly profiles: UiProfileService,
    private readonly audit: AuditService,
  ) {}

  /** `GET …/tasks/:key/design`: read through the plan's rule (D17). */
  async view(
    projectId: string,
    userId: string,
    planId: string,
    key: string,
  ): Promise<TaskDesignView> {
    const plan = await this.store.readable(userId, projectId, planId);
    const row = await this.prisma.taskDesign.findUnique({
      where: { planId_taskKey: { planId: plan.id, taskKey: key } },
      include: designInclude,
    });
    if (!row) {
      throw designError(404, DESIGN_ERROR.notFound, 'Design not found');
    }
    const project = await this.store.project(projectId);
    const [installed, settings, active] = await Promise.all([
      installedOf(this.prisma, project, row.skills),
      this.prisma.designSettings.findUnique({
        where: { projectId },
        select: { viewports: true },
      }),
      this.prisma.planTurn.findFirst({
        where: {
          planId: plan.id,
          action: 'design',
          task: { key },
          phase: { in: ['queued', 'running'] },
        },
        select: { id: true },
      }),
    ]);
    return toDesignView(row, {
      warnings: skillWarnings(row.skills, installed),
      viewports: settings
        ? viewportsOf(settings.viewports)
        : [...DEFAULT_VIEWPORTS],
      activeTurnId: active?.id ?? null,
    });
  }

  /**
   * `PATCH …/tasks/:key/design` (D2, D4, D15): the switch, the variant
   * count, the skills. A task without a design row gets one. Switching moves
   * the task between `ready` and `needs_design` (D1).
   */
  async patch(
    plan: Plan,
    key: string,
    request: TaskDesignPatchRequest,
    actor: PlanActor,
  ): Promise<void> {
    const task = await this.openTask(plan, key);
    const existing = await this.prisma.taskDesign.findUnique({
      where: { planId_taskKey: { planId: plan.id, taskKey: key } },
    });
    if (existing && isBusy(existing)) throw busy();
    if (
      existing?.status === 'approved' &&
      (request.variantCount !== undefined || request.skills !== undefined)
    ) {
      throw designError(
        409,
        DESIGN_ERROR.designApproved,
        'The design is approved',
      );
    }
    const design = existing
      ? await this.prisma.taskDesign.update({
          where: { id: existing.id },
          data: {
            ...(request.needed !== undefined ? { needed: request.needed } : {}),
            ...(request.variantCount !== undefined
              ? { variantCount: request.variantCount }
              : {}),
            ...(request.skills !== undefined ? { skills: request.skills } : {}),
          },
        })
      : await this.prisma.taskDesign.create({
          data: {
            planId: plan.id,
            taskKey: key,
            needed: request.needed ?? false,
            variantCount: request.variantCount ?? 1,
            skills:
              request.skills ??
              (await defaultSkillsOf(this.prisma, plan.projectId)),
          },
        });
    await this.gateTask(task, design);
    const before = existing?.needed ?? false;
    if (design.needed !== before) {
      await this.audit.record({
        ...actor.ctx,
        action: 'design.toggled',
        target: { type: 'plan', id: plan.id },
        projectId: plan.projectId,
        before: { key, needed: before },
        after: { key, needed: design.needed },
        result: 'ok',
      });
    }
    this.store.publishDesign(plan.projectId, plan.id, key);
  }

  /**
   * `POST …/design/generate` (D4, D13): the first revision of every variant
   * not drawn yet, one turn each, after the profile check — a missing or
   * stale profile is built first and the turns start when it is done.
   */
  async generate(plan: Plan, key: string, actor: PlanActor): Promise<void> {
    const { task, design } = await this.drawable(plan, key);
    const revisions = await this.prisma.designRevision.findMany({
      where: { designId: design.id },
      select: { variant: true, archived: true },
    });
    if (!batchOf('generate', design.variantCount, revisions, [], null)) {
      throw designError(
        409,
        DESIGN_ERROR.invalidArgs,
        'Every variant is drawn; leave comments and revise it',
      );
    }
    await this.start(plan, task, design, 'generate', [], actor);
  }

  /** `POST …/design/revise` (D10): every variant in play, with every open comment. */
  async revise(plan: Plan, key: string, actor: PlanActor): Promise<void> {
    const { task, design } = await this.drawable(plan, key);
    const open = await this.openComments(design.id);
    if (open.length === 0) {
      throw designError(
        409,
        DESIGN_ERROR.noOpenComments,
        'Revise needs an open comment',
      );
    }
    await this.start(plan, task, design, 'revise', open, actor);
  }

  /** `POST …/design/comments` (D9): left on the revision in view. */
  async comment(
    plan: Plan,
    key: string,
    request: DesignCommentRequest,
    actor: PlanActor,
  ): Promise<void> {
    this.store.assertOpen(plan);
    await this.store.task(plan, key);
    const design = await this.designOf(plan, key);
    if (!design.needed) throw this.off();
    if (design.status === 'approved') {
      throw designError(
        409,
        DESIGN_ERROR.designApproved,
        'The design is approved; it takes no more comments',
      );
    }
    const revision = await this.prisma.designRevision.findFirst({
      where: { id: request.revisionId, designId: design.id },
      select: { id: true },
    });
    if (!revision) {
      throw designError(
        400,
        DESIGN_ERROR.invalidArgs,
        'The revision is not a revision of this design',
      );
    }
    const anchored = request.kind !== 'general';
    if (anchored && (!request.viewport || !request.theme)) {
      throw designError(
        400,
        DESIGN_ERROR.invalidArgs,
        `A ${request.kind} comment names its viewport and theme`,
      );
    }
    if (
      request.kind === 'pin' &&
      (request.x === undefined ||
        request.y === undefined ||
        request.selector === undefined)
    ) {
      throw designError(
        400,
        DESIGN_ERROR.invalidArgs,
        'A pin carries its point and the CSS path under it',
      );
    }
    const pin = request.kind === 'pin';
    await this.prisma.designComment.create({
      data: {
        designId: design.id,
        revisionId: revision.id,
        authorId: actor.userId,
        kind: request.kind,
        viewport: anchored ? (request.viewport ?? null) : null,
        theme: anchored ? (request.theme ?? null) : null,
        x: pin ? (request.x ?? null) : null,
        y: pin ? (request.y ?? null) : null,
        selector: pin ? (request.selector ?? null) : null,
        body: request.body,
      },
    });
    this.store.publishDesign(plan.projectId, plan.id, key);
  }

  /**
   * `POST …/design/approve` (D1, D4): picks one revision; the other variants
   * are archived. The task leaves `needs_design`, and its write turn is
   * chained — once.
   */
  async approve(
    plan: Plan,
    key: string,
    revisionId: string,
    actor: PlanActor,
  ): Promise<void> {
    const task = await this.openTask(plan, key);
    const design = await this.designOf(plan, key);
    if (!design.needed) throw this.off();
    if (design.status === 'approved') {
      throw designError(
        409,
        DESIGN_ERROR.designApproved,
        'The design is approved',
      );
    }
    if (isBusy(design)) throw busy();
    const revision = await this.prisma.designRevision.findFirst({
      where: { id: revisionId, designId: design.id },
      select: { id: true, variant: true, revision: true },
    });
    if (!revision) {
      throw designError(
        400,
        DESIGN_ERROR.invalidArgs,
        'The revision is not a revision of this design',
      );
    }
    const approved = await this.prisma.$transaction(async (tx) => {
      await tx.designRevision.updateMany({
        where: { designId: design.id },
        data: { archived: true },
      });
      await tx.designRevision.updateMany({
        where: { designId: design.id, variant: revision.variant },
        data: { archived: false },
      });
      return tx.taskDesign.update({
        where: { id: design.id },
        data: {
          status: 'approved',
          approvedRevisionId: revision.id,
          approvedById: actor.userId,
          approvedAt: new Date(),
        },
      });
    });
    const status = await this.gateTask(task, approved);
    await this.audit.record({
      ...actor.ctx,
      action: 'design.approved',
      target: { type: 'plan', id: plan.id },
      projectId: plan.projectId,
      after: {
        key,
        revisionId: revision.id,
        variant: revision.variant,
        revision: revision.revision,
      },
      result: 'ok',
    });
    this.store.publishDesign(plan.projectId, plan.id, key);
    if (status === 'ready' && blockingOpen(questionsOf(task.questions)) === 0) {
      await this.turns.chain(plan.id, 'write', task.id, actor.userId);
    }
  }

  /**
   * D13: a profile build finished — the designs waiting for it start their
   * turns with the new version, or rest when it failed (`profileId`
   * undefined).
   */
  async afterBuild(
    waiting: readonly WaitingDesign[],
    profileId: string | null | undefined,
  ): Promise<void> {
    for (const w of waiting) {
      const design = await this.prisma.taskDesign.findUnique({
        where: { id: w.designId },
        include: { plan: true },
      });
      if (!design || !isBusy(design)) continue;
      const { plan } = design;
      const started =
        profileId !== undefined &&
        (await this.startWaiting(plan, design, w, profileId));
      if (!started) await settleDesign(this.prisma, plan.id, design.taskKey);
      this.store.publishDesign(plan.projectId, plan.id, design.taskKey);
    }
  }

  private async startWaiting(
    plan: Plan,
    design: TaskDesign,
    w: WaitingDesign,
    profileId: string | null,
  ): Promise<boolean> {
    if (plan.status === 'sent' || plan.status === 'archived') return false;
    const task = await this.prisma.planTask.findUnique({
      where: {
        planId_key_planVersion: {
          planId: plan.id,
          key: design.taskKey,
          planVersion: plan.version,
        },
      },
    });
    if (!task) return false;
    const batch = await this.batch(design, w.mode, profileId);
    if (!batch) return false;
    return this.turns.chainDesign(plan.id, task.id, batch, w.userId);
  }

  private async batch(
    design: Pick<TaskDesign, 'id' | 'variantCount'>,
    mode: DesignTurnPlan['mode'],
    profileId: string | null,
  ): Promise<DesignTurnPlan | null> {
    const [revisions, comments] = await Promise.all([
      this.prisma.designRevision.findMany({
        where: { designId: design.id },
        select: { variant: true, archived: true },
      }),
      mode === 'revise' ? this.openComments(design.id) : Promise.resolve([]),
    ]);
    return batchOf(mode, design.variantCount, revisions, comments, profileId);
  }

  /** The open comments' ids, oldest first, as many as one turn carries. */
  private async openComments(designId: string): Promise<string[]> {
    const rows = await this.prisma.designComment.findMany({
      where: { designId, addressedInRevisionId: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: DESIGN_COMMENTS_PER_TURN_MAX,
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Generate or Revise: the profile check first (D13), then the batch's
   * first turn; the projector starts the rest. A turn that does not start
   * puts the design back to rest.
   */
  private async start(
    plan: Plan,
    task: PlanTask,
    design: TaskDesign,
    mode: DesignTurnPlan['mode'],
    comments: string[],
    actor: PlanActor,
  ): Promise<void> {
    const active = await this.prisma.planTurn.count({
      where: { planId: plan.id, phase: { in: ['queued', 'running'] } },
    });
    if (active > 0) {
      throw plannerError(
        409,
        PLANNER_ERROR.turnInProgress,
        'A turn of this plan is queued or running',
      );
    }
    const caller: PlanCaller = callerOf(actor);
    const project = await this.store.project(plan.projectId);
    const readiness = await this.profiles.ensureFresh(project, caller, {
      designId: design.id,
      mode,
      userId: actor.userId,
    });
    await this.prisma.taskDesign.update({
      where: { id: design.id },
      data: { status: mode === 'generate' ? 'generating' : 'revising' },
    });
    this.store.publishDesign(plan.projectId, plan.id, task.key);
    let turnId: string | null = null;
    if (readiness.kind === 'ready') {
      const batch = await this.batch(design, mode, readiness.profileId);
      if (!batch) {
        await settleDesign(this.prisma, plan.id, task.key);
        return;
      }
      try {
        turnId = await this.turns.designTurn(plan, task, batch, caller);
      } catch (error) {
        await settleDesign(this.prisma, plan.id, task.key);
        this.store.publishDesign(plan.projectId, plan.id, task.key);
        throw error;
      }
    }
    await this.audit.record({
      ...actor.ctx,
      action: mode === 'generate' ? 'design.generated' : 'design.revised',
      target: { type: 'plan', id: plan.id },
      projectId: plan.projectId,
      after: {
        key: task.key,
        variantCount: design.variantCount,
        ...(mode === 'revise' ? { comments } : {}),
        ...(readiness.kind === 'building'
          ? { profileBuildRunId: readiness.runId }
          : { turnId }),
      },
      result: 'ok',
    });
  }

  /** A task whose design may still change: the plan open, the task not settled. */
  private async openTask(plan: Plan, key: string): Promise<PlanTask> {
    this.store.assertOpen(plan);
    const task = await this.store.task(plan, key);
    if (task.frozen || (SETTLED as readonly string[]).includes(task.status)) {
      throw designError(
        409,
        DESIGN_ERROR.taskFrozen,
        `Task ${key} is ${task.status}; its design no longer changes`,
      );
    }
    return task;
  }

  /** A design that takes a Generate or a Revise now. */
  private async drawable(plan: Plan, key: string) {
    const task = await this.openTask(plan, key);
    const design = await this.designOf(plan, key);
    if (!design.needed) throw this.off();
    if (design.status === 'approved') {
      throw designError(
        409,
        DESIGN_ERROR.designApproved,
        'The design is approved',
      );
    }
    if (isBusy(design)) throw busy();
    return { task, design };
  }

  private async designOf(plan: Plan, key: string): Promise<TaskDesign> {
    const design = await this.prisma.taskDesign.findUnique({
      where: { planId_taskKey: { planId: plan.id, taskKey: key } },
    });
    if (!design) throw this.off();
    return design;
  }

  private off() {
    return designError(
      409,
      DESIGN_ERROR.designOff,
      'The design of this task is off',
    );
  }

  /** D1: the task's status follows its design; returns the status it has now. */
  private async gateTask(
    task: PlanTask,
    design: Pick<TaskDesign, 'needed' | 'status'>,
  ) {
    const status = withDesign(task.status, design);
    if (status !== task.status) {
      await this.prisma.planTask.update({
        where: { id: task.id },
        data: { status },
      });
    }
    return status;
  }
}
