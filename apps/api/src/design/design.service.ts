import {
  type CardAutoRun,
  type CardAutoRunFailure,
  DESIGN_COMMENTS_PER_TURN_MAX,
  DESIGN_ERROR,
  type DesignCommentRequest,
  isCardAutoRunCode,
  PLANNER_ERROR,
  type TaskDesignPatchRequest,
  type TaskDesignView,
} from '@agentdock/shared';
import { RUNNER_FEATURE_COMMANDS } from '@agentdock/shared/protocol';
import { HttpException, Injectable, type OnModuleInit } from '@nestjs/common';
import type { BoardCard, Plan, PlanTask, TaskDesign } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { cardNotFound } from '../board/board-error';
import { BoardRoundsService } from '../board/board-rounds.service';
import { PrismaService } from '../database/prisma.service';
import { CardDesignTurnService } from '../planner/card-design-turn.service';
import { callerOf, type PlanActor } from '../planner/plan.service';
import { blockingOpen, questionsOf } from '../planner/plan-mapper';
import { PlanStore } from '../planner/plan-store';
import { type PlanCaller, PlanTurnService } from '../planner/plan-turn.service';
import { plannerError } from '../planner/planner-error';
import { TextNormalizer } from '../text/text-normalizer';
import { TextOwners } from '../text/text-owners';
import { settleDesign } from './design-apply';
import { DesignCommands } from './design-commands';
import { designError } from './design-error';
import { busyStatusOf, type DesignOwner } from './design-owner';
import {
  batchOf,
  commentAnchor,
  type DesignTurnPlan,
  withDesign,
} from './design-rules';
import { type DesignKey, defaultSkillsOf, designWhere } from './design-store';
import { loadDesignView } from './design-view';
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

const approvedAlready = (what = 'The design is approved') =>
  designError(409, DESIGN_ERROR.designApproved, what);

/** #273 D8: `CardAutoRun.message` is at most this many characters. */
const AUTO_RUN_MESSAGE_MAX = 500;

/**
 * #273 D8: why a start was refused — the refusal's `error` when it is a
 * board code (`max_running`, `budget_exceeded`, `command_unavailable`, …),
 * else `unknown`, with its message.
 */
const autoRunFailureOf = (
  error: unknown,
): { code: CardAutoRunFailure['code']; message: string } => {
  const body = error instanceof HttpException ? error.getResponse() : null;
  const code =
    body !== null &&
    typeof body === 'object' &&
    'error' in body &&
    typeof body.error === 'string' &&
    isCardAutoRunCode(body.error)
      ? body.error
      : 'unknown';
  const message = error instanceof Error ? error.message : String(error);
  return { code, message: message.slice(0, AUTO_RUN_MESSAGE_MAX) };
};

/** How strictly a task owner is checked: any change, or only a comment. */
type TaskCheck = 'change' | 'comment';

/**
 * A design (docs/specs/223-design-stage.md D1–D4, D8–D11, D15, D17; #243):
 * the switch, the variant count and skills, Generate, comments, Revise and
 * Approve. One flow for both owners of ADR-0025 — a plan task, whose turns
 * are the planner's (`PlanTurnService`), and a board card, whose turns are
 * `CardDesignTurnService`'s — through the `DesignOwner` seam. The profile is
 * checked and built first (`UiProfileService`, D13).
 */
@Injectable()
export class DesignService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: PlanStore,
    private readonly turns: PlanTurnService,
    private readonly cardTurns: CardDesignTurnService,
    private readonly rounds: BoardRoundsService,
    private readonly profiles: UiProfileService,
    private readonly audit: AuditService,
    private readonly commands: DesignCommands,
    private readonly text: TextNormalizer,
    private readonly textOwners: TextOwners,
  ) {}

  /** #271: a comment's English body lands as its design's live event. */
  onModuleInit(): void {
    this.textOwners.register('design_comment', {
      publish: async (projectId, commentId) => {
        const comment = await this.prisma.designComment.findUnique({
          where: { id: commentId },
          select: {
            design: { select: { planId: true, taskKey: true, cardId: true } },
          },
        });
        const design = comment?.design;
        if (design?.cardId) {
          this.store.publishCardDesign(projectId, design.cardId);
        } else if (design?.planId) {
          this.store.publishDesign(projectId, design.planId, design.taskKey);
        }
      },
    });
  }

  // ─── Plan task ─────────────────────────────────────────────────────────────

  /** `GET …/tasks/:key/design`: read through the plan's rule (D17). */
  async view(
    projectId: string,
    userId: string,
    planId: string,
    key: string,
  ): Promise<TaskDesignView> {
    const plan = await this.store.readable(userId, projectId, planId);
    const project = await this.store.project(projectId);
    return loadDesignView(this.prisma, project, {
      planId: plan.id,
      taskKey: key,
    });
  }

  /** `PATCH …/tasks/:key/design` (D2, D4, D15). */
  async patch(
    plan: Plan,
    key: string,
    request: TaskDesignPatchRequest,
    actor: PlanActor,
  ): Promise<void> {
    await this.patchOf(
      await this.taskOwner(plan, key, 'change'),
      request,
      actor,
    );
  }

  /** `POST …/design/generate` (D4, D13). */
  async generate(plan: Plan, key: string, actor: PlanActor): Promise<void> {
    await this.generateOf(await this.taskOwner(plan, key, 'change'), actor);
  }

  /** `POST …/design/revise` (D10). */
  async revise(plan: Plan, key: string, actor: PlanActor): Promise<void> {
    await this.reviseOf(await this.taskOwner(plan, key, 'change'), actor);
  }

  /** `POST …/design/comments` (D9). */
  async comment(
    plan: Plan,
    key: string,
    request: DesignCommentRequest,
    actor: PlanActor,
  ): Promise<void> {
    await this.commentOf(
      await this.taskOwner(plan, key, 'comment'),
      request,
      actor,
    );
  }

  /** `POST …/design/approve` (D1, D4): the task's write turn is chained, once. */
  async approve(
    plan: Plan,
    key: string,
    revisionId: string,
    actor: PlanActor,
  ): Promise<void> {
    await this.approveOf(
      await this.taskOwner(plan, key, 'change'),
      revisionId,
      actor,
    );
  }

  // ─── Board card (#243) ─────────────────────────────────────────────────────

  /** `GET …/board/cards/:number/design`: any project viewer (D8). */
  async cardView(projectId: string, number: number): Promise<TaskDesignView> {
    const card = await this.card(projectId, number);
    const project = await this.store.project(projectId);
    return loadDesignView(this.prisma, project, { cardId: card.id });
  }

  async cardPatch(
    projectId: string,
    number: number,
    request: TaskDesignPatchRequest,
    actor: PlanActor,
  ): Promise<void> {
    await this.patchOf(await this.cardOwner(projectId, number), request, actor);
    if (request.needed !== undefined) {
      // #273 D9: the design the failed auto-run followed no longer stands.
      await this.prisma.boardCard.updateMany({
        where: { projectId, number, autoRunError: { not: null } },
        data: {
          autoRunError: null,
          autoRunMessage: null,
          autoRunFailedAt: null,
        },
      });
    }
  }

  async cardGenerate(
    projectId: string,
    number: number,
    actor: PlanActor,
  ): Promise<void> {
    await this.generateOf(await this.cardOwner(projectId, number), actor);
  }

  async cardRevise(
    projectId: string,
    number: number,
    actor: PlanActor,
  ): Promise<void> {
    await this.reviseOf(await this.cardOwner(projectId, number), actor);
  }

  async cardComment(
    projectId: string,
    number: number,
    request: DesignCommentRequest,
    actor: PlanActor,
  ): Promise<void> {
    await this.commentOf(
      await this.cardOwner(projectId, number),
      request,
      actor,
    );
  }

  /**
   * D6, D7: no write turn; `plan.close` drops the card's design worktree; and
   * with "Continue after design" on, round 1 starts as the approver. When it
   * cannot start, the approval stands, the card stays in To Do and the
   * request answers with why.
   */
  async cardApprove(
    projectId: string,
    number: number,
    revisionId: string,
    actor: PlanActor,
  ): Promise<CardAutoRun | null> {
    // #273 D8: what Continue after design did; `null` while it is off.
    let run: CardAutoRun | null = null;
    await this.approveOf(
      await this.cardOwner(projectId, number, (outcome) => {
        run = outcome;
      }),
      revisionId,
      actor,
    );
    return run;
  }

  // ─── Both owners ───────────────────────────────────────────────────────────

  /**
   * The switch, the variant count, the skills (D2, D4, D15). An owner without
   * a design row gets one. A task moves between `ready` and `needs_design`
   * (D1).
   */
  private async patchOf(
    owner: DesignOwner,
    request: TaskDesignPatchRequest,
    actor: PlanActor,
  ): Promise<void> {
    const existing = await this.prisma.taskDesign.findUnique({
      where: designWhere(owner.key),
    });
    if (existing && isBusy(existing)) throw busy();
    if (
      existing?.status === 'approved' &&
      (request.variantCount !== undefined || request.skills !== undefined)
    ) {
      throw approvedAlready();
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
            ...owner.key,
            needed: request.needed ?? false,
            variantCount: request.variantCount ?? 1,
            skills:
              request.skills ??
              (await defaultSkillsOf(this.prisma, owner.projectId)),
          },
        });
    await owner.gate(design);
    const before = existing?.needed ?? false;
    if (design.needed !== before) {
      await this.audit.record({
        ...actor.ctx,
        action: 'design.toggled',
        target: owner.target,
        projectId: owner.projectId,
        before: { ...owner.label, needed: before },
        after: { ...owner.label, needed: design.needed },
        result: 'ok',
      });
    }
    owner.publish();
  }

  /**
   * Generate (D4, D13): the first revision of every variant not drawn yet,
   * one turn each, after the profile check — a missing or stale profile is
   * built first and the turns start when it is done.
   */
  private async generateOf(
    owner: DesignOwner,
    actor: PlanActor,
  ): Promise<void> {
    const design = await this.drawable(owner);
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
    await this.start(owner, design, 'generate', [], actor);
  }

  /** Revise (D10): every variant in play, with every open comment. */
  private async reviseOf(owner: DesignOwner, actor: PlanActor): Promise<void> {
    const design = await this.drawable(owner);
    const open = await this.openComments(design.id);
    if (open.length === 0) {
      throw designError(
        409,
        DESIGN_ERROR.noOpenComments,
        'Revise needs an open comment',
      );
    }
    await this.start(owner, design, 'revise', open, actor);
  }

  /** A comment (D9), left on the revision in view. */
  private async commentOf(
    owner: DesignOwner,
    request: DesignCommentRequest,
    actor: PlanActor,
  ): Promise<void> {
    const design = await this.designOf(owner);
    if (!design.needed) throw this.off(owner);
    if (design.status === 'approved') {
      throw approvedAlready(
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
    const anchor = commentAnchor(request);
    if (typeof anchor === 'string') {
      throw designError(400, DESIGN_ERROR.invalidArgs, anchor);
    }
    const comment = await this.prisma.designComment.create({
      data: {
        designId: design.id,
        revisionId: revision.id,
        authorId: actor.userId,
        kind: request.kind,
        ...anchor,
        body: request.body,
      },
      select: { id: true },
    });
    owner.publish();
    // #271 D1: a comment on a card's design or a task's.
    await this.text.request(
      owner.projectId,
      { ownerType: 'design_comment', ownerId: comment.id },
      [{ field: 'body', text: request.body }],
      { authorId: actor.userId },
    );
  }

  /** Approve (D1, D4): picks one revision; the other variants are archived. */
  private async approveOf(
    owner: DesignOwner,
    revisionId: string,
    actor: PlanActor,
  ): Promise<void> {
    const design = await this.designOf(owner);
    if (!design.needed) throw this.off(owner);
    if (design.status === 'approved') throw approvedAlready();
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
      // Only the first of two concurrent approvals wins.
      const claimed = await tx.taskDesign.updateMany({
        where: { id: design.id, status: { not: 'approved' } },
        data: {
          status: 'approved',
          approvedRevisionId: revision.id,
          approvedById: actor.userId,
          approvedAt: new Date(),
          busySince: null,
        },
      });
      if (claimed.count === 0) throw approvedAlready();
      await tx.designRevision.updateMany({
        where: { designId: design.id },
        data: { archived: true },
      });
      await tx.designRevision.updateMany({
        where: { designId: design.id, variant: revision.variant },
        data: { archived: false },
      });
      return tx.taskDesign.findUniqueOrThrow({ where: { id: design.id } });
    });
    await owner.gate(approved);
    await this.audit.record({
      ...actor.ctx,
      action: 'design.approved',
      target: owner.target,
      projectId: owner.projectId,
      after: {
        ...owner.label,
        revisionId: revision.id,
        variant: revision.variant,
        revision: revision.revision,
      },
      result: 'ok',
    });
    owner.publish();
    await owner.onApproved(approved, actor);
  }

  /**
   * D13: a profile build finished — the designs waiting for it start their
   * turns with the new version, or rest when it failed (`profileId`
   * undefined). Their turns record `buildRunId` as step 1 of 2 (#275 D1).
   */
  async afterBuild(
    waiting: readonly WaitingDesign[],
    profileId: string | null | undefined,
    buildRunId?: string,
  ): Promise<void> {
    for (const w of waiting) {
      const design = await this.prisma.taskDesign.findUnique({
        where: { id: w.designId },
        include: {
          plan: true,
          card: { include: { _count: { select: { rounds: true } } } },
        },
      });
      if (!design || !isBusy(design)) continue;
      const key = this.keyOf(design);
      if (!key) continue;
      const started =
        profileId !== undefined &&
        (await this.startWaiting(design, key, w, profileId, buildRunId));
      if (!started) await settleDesign(this.prisma, key);
      if ('cardId' in key) {
        if (design.card) {
          this.store.publishCardDesign(design.card.projectId, key.cardId);
        }
      } else if (design.plan) {
        this.store.publishDesign(
          design.plan.projectId,
          key.planId,
          key.taskKey,
        );
      }
    }
  }

  private keyOf(
    design: Pick<TaskDesign, 'planId' | 'taskKey' | 'cardId'>,
  ): DesignKey | null {
    if (design.cardId !== null) return { cardId: design.cardId };
    if (design.planId !== null && design.taskKey !== null) {
      return { planId: design.planId, taskKey: design.taskKey };
    }
    return null;
  }

  private async startWaiting(
    design: TaskDesign & {
      plan: Plan | null;
      card: (BoardCard & { _count: { rounds: number } }) | null;
    },
    key: DesignKey,
    w: WaitingDesign,
    profileId: string | null,
    buildRunId: string | undefined,
  ): Promise<boolean> {
    const drawn = await this.batch(design, w.mode, profileId);
    if (!drawn) return false;
    const batch: DesignTurnPlan = buildRunId
      ? { ...drawn, profileBuildRunId: buildRunId }
      : drawn;
    if ('cardId' in key) {
      // Designs freeze once a round exists (#243 "Out of scope").
      if (!design.card || design.card._count.rounds > 0) return false;
      return this.cardTurns.chain(key.cardId, batch, w.userId);
    }
    const plan = design.plan;
    if (!plan || plan.status === 'sent' || plan.status === 'archived') {
      return false;
    }
    const task = await this.prisma.planTask.findUnique({
      where: {
        planId_key_planVersion: {
          planId: plan.id,
          key: key.taskKey,
          planVersion: plan.version,
        },
      },
    });
    if (!task) return false;
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
    owner: DesignOwner,
    design: TaskDesign,
    mode: DesignTurnPlan['mode'],
    comments: string[],
    actor: PlanActor,
  ): Promise<void> {
    await owner.assertIdle();
    const caller: PlanCaller = callerOf(actor);
    const project = await this.store.project(owner.projectId);
    // Every command the stage may need, before the profile check writes
    // anything (a joined build, a first fingerprint, the busy status) (#233).
    this.commands.assertServed(
      project.runnerId,
      RUNNER_FEATURE_COMMANDS.design,
    );
    const readiness = await this.profiles.ensureFresh(project, caller, {
      designId: design.id,
      mode,
      userId: actor.userId,
    });
    await this.prisma.taskDesign.update({
      where: { id: design.id },
      data: { status: busyStatusOf(mode), busySince: new Date() },
    });
    owner.publish();
    let turnId: string | null = null;
    if (readiness.kind === 'ready') {
      const batch = await this.batch(design, mode, readiness.profileId);
      if (!batch) {
        await settleDesign(this.prisma, owner.key);
        return;
      }
      try {
        turnId = await owner.runTurn(batch, caller);
      } catch (error) {
        await settleDesign(this.prisma, owner.key);
        owner.publish();
        throw error;
      }
    }
    await this.audit.record({
      ...actor.ctx,
      action: mode === 'generate' ? 'design.generated' : 'design.revised',
      target: owner.target,
      projectId: owner.projectId,
      after: {
        ...owner.label,
        variantCount: design.variantCount,
        ...(mode === 'revise' ? { comments } : {}),
        ...(readiness.kind === 'building'
          ? { profileBuildRunId: readiness.runId }
          : { turnId }),
      },
      result: 'ok',
    });
  }

  /** A design that takes a Generate or a Revise now. */
  private async drawable(owner: DesignOwner): Promise<TaskDesign> {
    const design = await this.designOf(owner);
    if (!design.needed) throw this.off(owner);
    if (design.status === 'approved') throw approvedAlready();
    if (isBusy(design)) throw busy();
    return design;
  }

  private async designOf(owner: DesignOwner): Promise<TaskDesign> {
    const design = await this.prisma.taskDesign.findUnique({
      where: designWhere(owner.key),
    });
    if (!design) throw this.off(owner);
    return design;
  }

  private off(owner: DesignOwner) {
    return designError(
      409,
      DESIGN_ERROR.designOff,
      `The design of this ${owner.kind} is off`,
    );
  }

  // ─── Owners ────────────────────────────────────────────────────────────────

  /**
   * A plan task's design, once the plan is open and — for a change — the
   * task not settled (D2).
   */
  private async taskOwner(
    plan: Plan,
    key: string,
    check: TaskCheck,
  ): Promise<DesignOwner> {
    this.store.assertOpen(plan);
    const task = await this.store.task(plan, key);
    if (
      check === 'change' &&
      (task.frozen || (SETTLED as readonly string[]).includes(task.status))
    ) {
      throw designError(
        409,
        DESIGN_ERROR.taskFrozen,
        `Task ${key} is ${task.status}; its design no longer changes`,
      );
    }
    let status = task.status;
    return {
      kind: 'task',
      key: { planId: plan.id, taskKey: key },
      projectId: plan.projectId,
      target: { type: 'plan', id: plan.id },
      label: { key },
      gate: async (design) => {
        status = await this.gateTask(task, design);
      },
      assertIdle: async () => {
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
      },
      runTurn: (batch, caller) =>
        this.turns.designTurn(plan, task, batch, caller),
      onApproved: async (_design, actor) => {
        if (
          status === 'ready' &&
          blockingOpen(questionsOf(task.questions)) === 0
        ) {
          await this.turns.chain(plan.id, 'write', task.id, actor.userId);
        }
      },
      publish: () => this.store.publishDesign(plan.projectId, plan.id, key),
    };
  }

  /** A card's design, while Run has not started: designs freeze once a round exists. */
  private async cardOwner(
    projectId: string,
    number: number,
    onAutoRun: (run: CardAutoRun) => void = () => {},
  ): Promise<DesignOwner> {
    const card = await this.card(projectId, number);
    const rounds = await this.prisma.boardCardRound.count({
      where: { cardId: card.id },
    });
    if (rounds > 0) {
      throw designError(
        409,
        DESIGN_ERROR.taskFrozen,
        `Card C-${number} has run; its design no longer changes`,
      );
    }
    return {
      kind: 'card',
      key: { cardId: card.id },
      projectId,
      target: { type: 'board_card', id: card.id },
      label: { number },
      gate: async () => {},
      assertIdle: async () => {
        const active = await this.prisma.planTurn.count({
          where: { cardId: card.id, phase: { in: ['queued', 'running'] } },
        });
        if (active > 0) {
          throw plannerError(
            409,
            PLANNER_ERROR.turnInProgress,
            'A design turn of this card is queued or running',
          );
        }
      },
      runTurn: (batch, caller) => this.cardTurns.start(card, batch, caller),
      onApproved: async (_design, actor) => {
        await this.cardTurns.close(card, actor);
        const fresh = await this.prisma.boardCard.findUnique({
          where: { id: card.id },
          select: { continueAfterDesign: true },
        });
        if (fresh?.continueAfterDesign) {
          onAutoRun(await this.autoRun(card, actor));
        }
      },
      publish: () => this.store.publishCardDesign(projectId, card.id),
    };
  }

  /**
   * #273 D8, D9: round 1 as the approver. A refused start never fails the
   * approval, which has committed: it is stored on the card, audited and
   * answered as `run_failed`.
   */
  private async autoRun(
    card: BoardCard,
    actor: PlanActor,
  ): Promise<CardAutoRun> {
    try {
      const detail = await this.rounds.run(
        card.projectId,
        card.number,
        {},
        actor,
      );
      return { status: 'started', round: detail.round?.round ?? 1 };
    } catch (error) {
      const { code, message } = autoRunFailureOf(error);
      const at = new Date();
      await this.prisma.boardCard.update({
        where: { id: card.id },
        data: {
          autoRunError: code,
          autoRunMessage: message,
          autoRunFailedAt: at,
        },
      });
      await this.audit.record({
        ...actor.ctx,
        action: 'card.auto_run_failed',
        target: { type: 'board_card', id: card.id },
        projectId: card.projectId,
        // `code` is a redacted audit key (auth codes): the refusal goes as `error`.
        after: { number: card.number, error: code },
        result: 'error',
        meta: { message },
      });
      this.store.publishCardDesign(card.projectId, card.id);
      return { status: 'run_failed', code, message };
    }
  }

  private async card(projectId: string, number: number): Promise<BoardCard> {
    const card = await this.prisma.boardCard.findUnique({
      where: { projectId_number: { projectId, number } },
    });
    if (!card) throw cardNotFound();
    return card;
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
