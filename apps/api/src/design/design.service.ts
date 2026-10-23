import {
  type CardAutoRun,
  type CardDesignGenerateRequest,
  type CardDesignLaunchRequest,
  DESIGN_COMMENTS_PER_TURN_MAX,
  DESIGN_ERROR,
  type DesignCommentRequest,
  type DesignGenerateRequest,
  PLANNER_ERROR,
  type Role,
  type TaskDesignPatchRequest,
  type TaskDesignView,
  type ViewportPreset,
  viewportPresetsSchema,
} from '@nautelle/shared';
import { RUNNER_FEATURE_COMMANDS } from '@nautelle/shared/protocol';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  BoardCard,
  BoardStack,
  Plan,
  PlanTask,
  Prisma,
  TaskDesign,
} from '@prisma/client';
import { z } from 'zod';
import { CardAssessor } from '../assess/card-assessor';
import { AuditService } from '../audit/audit.service';
import { autoRunFailureOf, cardNotFound } from '../board/board-error';
import { BoardRoundsService } from '../board/board-rounds.service';
import { BoardStacks } from '../board/board-stacks';
import { hiddenFrom } from '../board/inbox-access';
import { PrismaService } from '../database/prisma.service';
import { CardDesignTurnService } from '../planner/card-design-turn.service';
import { callerOf, type PlanActor } from '../planner/plan.service';
import { blockingOpen, questionsOf } from '../planner/plan-mapper';
import { PlanStore } from '../planner/plan-store';
import { type PlanCaller, PlanTurnService } from '../planner/plan-turn.service';
import { plannerError } from '../planner/planner-error';
import { StackDesignTurnService } from '../planner/stack-design-turn.service';
import { TextNormalizer } from '../text/text-normalizer';
import { TextOwners } from '../text/text-owners';
import { settleDesign } from './design-apply';
import { DesignCommands } from './design-commands';
import { designError } from './design-error';
import { busyStatusOf, type DesignOwner } from './design-owner';
import {
  batchOf,
  commentAnchor,
  completeBatchOf,
  type DesignTurnPlan,
  withDesign,
} from './design-rules';
import {
  conformanceOfRow,
  type DesignKey,
  defaultSkillsOf,
  designWhere,
  followsDefaultSkills,
  projectDesignTemplateKeys,
  projectViewports,
} from './design-store';
import { loadDesignView } from './design-view';
import { UiProfileLearner } from './learn/ui-profile-learner';
import { type ProfileReadiness, UiProfileService } from './ui-profile.service';
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
    private readonly stackTurns: StackDesignTurnService,
    private readonly rounds: BoardRoundsService,
    private readonly stacks: BoardStacks,
    private readonly profiles: UiProfileService,
    private readonly audit: AuditService,
    private readonly commands: DesignCommands,
    private readonly text: TextNormalizer,
    private readonly textOwners: TextOwners,
    private readonly assessor: CardAssessor,
    private readonly learner: UiProfileLearner,
  ) {}

  /** #271: a comment's English body lands as its design's live event. */
  onModuleInit(): void {
    this.textOwners.register('design_comment', {
      publish: async (projectId, commentId) => {
        const comment = await this.prisma.designComment.findUnique({
          where: { id: commentId },
          select: {
            design: {
              select: {
                planId: true,
                taskKey: true,
                cardId: true,
                stackId: true,
              },
            },
          },
        });
        const design = comment?.design;
        if (design?.cardId) {
          this.store.publishCardDesign(projectId, design.cardId);
        } else if (design?.stackId) {
          this.store.publishStackDesign(projectId, design.stackId);
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
  async generate(
    plan: Plan,
    key: string,
    actor: PlanActor,
    request: DesignGenerateRequest = {},
  ): Promise<void> {
    const owner = await this.taskOwner(plan, key, 'change');
    await this.generateOf(
      owner,
      actor,
      await this.devicesFor(owner.projectId, request),
    );
  }

  /** `POST …/design/revise` (D10). */
  async revise(plan: Plan, key: string, actor: PlanActor): Promise<void> {
    await this.reviseOf(await this.taskOwner(plan, key, 'change'), actor);
  }

  /** #833 D7: `POST …/design/complete` — the repair turn by hand. */
  async complete(plan: Plan, key: string, actor: PlanActor): Promise<void> {
    await this.completeOf(await this.taskOwner(plan, key, 'change'), actor);
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

  /**
   * `GET …/board/cards/:number/design`: any project viewer (D8), but an Inbox
   * card's only for operators (#244 D8). A write answers its design with no
   * role: the caller already holds operator.
   */
  async cardView(
    projectId: string,
    number: number,
    role?: Role,
  ): Promise<TaskDesignView> {
    const card = await this.card(projectId, number);
    if (hiddenFrom(card, role)) throw cardNotFound();
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
    launch: CardDesignGenerateRequest = {},
  ): Promise<void> {
    const owner = await this.cardOwner(projectId, number);
    await this.stacks.assertStackApproved(owner.target.id);
    const devices = await this.devicesFor(projectId, launch);
    await this.rememberLaunch(owner, projectId, number, launch);
    await this.generateOf(owner, actor, devices);
  }

  async cardRevise(
    projectId: string,
    number: number,
    actor: PlanActor,
    launch: CardDesignLaunchRequest = {},
  ): Promise<void> {
    const owner = await this.cardOwner(projectId, number);
    await this.stacks.assertStackApproved(owner.target.id);
    await this.rememberLaunch(owner, projectId, number, launch);
    await this.reviseOf(owner, actor);
  }

  async cardComplete(
    projectId: string,
    number: number,
    actor: PlanActor,
  ): Promise<void> {
    const owner = await this.cardOwner(projectId, number);
    await this.stacks.assertStackApproved(owner.target.id);
    await this.completeOf(owner, actor);
  }

  /**
   * #322 D3: the launch popover's choice, stored once the design takes a
   * Generate or a Revise, so the batch's chained turns read it too.
   */
  private async rememberLaunch(
    owner: DesignOwner,
    projectId: string,
    number: number,
    launch: CardDesignLaunchRequest,
  ): Promise<void> {
    await this.drawable(owner);
    await owner.assertIdle();
    await this.cardTurns.rememberLaunch(
      await this.card(projectId, number),
      launch,
    );
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

  // ─── Stack (#480, ADR-0044) ────────────────────────────────────────────────

  /** `GET …/board/stacks/:number/design`: any project viewer. */
  async stackView(projectId: string, number: number): Promise<TaskDesignView> {
    const stack = await this.stack(projectId, number);
    const project = await this.store.project(projectId);
    return loadDesignView(this.prisma, project, { stackId: stack.id });
  }

  async stackPatch(
    projectId: string,
    number: number,
    request: TaskDesignPatchRequest,
    actor: PlanActor,
  ): Promise<void> {
    await this.patchOf(
      await this.stackOwner(projectId, number),
      request,
      actor,
    );
  }

  async stackGenerate(
    projectId: string,
    number: number,
    actor: PlanActor,
    request: DesignGenerateRequest = {},
  ): Promise<void> {
    const owner = await this.stackOwner(projectId, number);
    await this.generateOf(
      owner,
      actor,
      await this.devicesFor(projectId, request),
    );
  }

  async stackRevise(
    projectId: string,
    number: number,
    actor: PlanActor,
  ): Promise<void> {
    await this.reviseOf(await this.stackOwner(projectId, number), actor);
  }

  async stackComplete(
    projectId: string,
    number: number,
    actor: PlanActor,
  ): Promise<void> {
    await this.completeOf(await this.stackOwner(projectId, number), actor);
  }

  async stackComment(
    projectId: string,
    number: number,
    request: DesignCommentRequest,
    actor: PlanActor,
  ): Promise<void> {
    await this.commentOf(
      await this.stackOwner(projectId, number),
      request,
      actor,
    );
  }

  /** Approving lifts the design-first gate: the stack's cards may run. */
  async stackApprove(
    projectId: string,
    number: number,
    revisionId: string,
    actor: PlanActor,
  ): Promise<void> {
    await this.approveOf(
      await this.stackOwner(projectId, number),
      revisionId,
      actor,
    );
  }

  // ─── Both owners ───────────────────────────────────────────────────────────

  /**
   * The switch, the variant count, the skills (D2, D4, D15). An owner without
   * a design row gets one. A task moves between `ready` and `needs_design`
   * (D1). Skills sent here are a hand edit the design keeps; `useDefaultSkills`
   * drops it, and the design follows the project default again (#604).
   */
  private async patchOf(
    owner: DesignOwner,
    request: TaskDesignPatchRequest,
    actor: PlanActor,
  ): Promise<void> {
    if (request.useDefaultSkills && request.skills !== undefined) {
      throw designError(
        400,
        DESIGN_ERROR.invalidArgs,
        'Send skills or useDefaultSkills, not both',
      );
    }
    const existing = await this.prisma.taskDesign.findUnique({
      where: designWhere(owner.key),
    });
    if (existing && isBusy(existing)) throw busy();
    if (
      existing?.status === 'approved' &&
      (request.variantCount !== undefined ||
        request.skills !== undefined ||
        request.useDefaultSkills)
    ) {
      throw approvedAlready();
    }
    if (request.templateKey !== undefined) {
      if (existing?.status === 'approved') throw approvedAlready();
      if (
        !(
          await projectDesignTemplateKeys(this.prisma, owner.projectId)
        ).includes(request.templateKey)
      ) {
        throw designError(
          400,
          DESIGN_ERROR.invalidArgs,
          'templateKey is not a design template of this project',
        );
      }
    }
    // A plan task's and a stack's template live on the design (#833 D8).
    const template =
      request.templateKey !== undefined && !('cardId' in owner.key)
        ? {
            templateKey: request.templateKey,
            templateSource: 'person' as const,
          }
        : {};
    const skills =
      request.skills !== undefined
        ? { skills: request.skills, skillsEdited: true }
        : request.useDefaultSkills || !existing
          ? {
              skills: await defaultSkillsOf(this.prisma, owner.projectId),
              skillsEdited: false,
            }
          : {};
    const design = existing
      ? await this.prisma.taskDesign.update({
          where: { id: existing.id },
          data: {
            ...(request.needed !== undefined ? { needed: request.needed } : {}),
            ...(request.variantCount !== undefined
              ? { variantCount: request.variantCount }
              : {}),
            ...template,
            ...skills,
          },
        })
      : await this.prisma.taskDesign.create({
          data: {
            ...owner.key,
            needed: request.needed ?? false,
            variantCount: request.variantCount ?? 1,
            ...template,
            ...skills,
          },
        });
    // A card's template is the card's own (D8): the person's choice there.
    if (request.templateKey !== undefined && 'cardId' in owner.key) {
      await this.prisma.boardCard.update({
        where: { id: owner.key.cardId },
        data: {
          designTemplate: request.templateKey,
          designTemplateSource: 'person',
        },
      });
    }
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
    devices: ViewportPreset[],
  ): Promise<void> {
    const drawable = await this.drawable(owner);
    const revisions = await this.prisma.designRevision.findMany({
      where: { designId: drawable.id },
      select: { variant: true, archived: true },
    });
    if (!batchOf('generate', drawable.variantCount, revisions, [], null)) {
      throw designError(
        409,
        DESIGN_ERROR.invalidArgs,
        'Every variant is drawn; leave comments and revise it',
      );
    }
    // #604: a design that follows the default takes today's default; its
    // turns, and every later one, read that copy.
    const design = followsDefaultSkills(drawable, revisions.length > 0)
      ? await this.prisma.taskDesign.update({
          where: { id: drawable.id },
          data: { skills: await defaultSkillsOf(this.prisma, owner.projectId) },
        })
      : drawable;
    // #863: so do the devices — a later edit of the project's presets leaves
    // them. They are written with the busy claim, so a refused Generate never
    // changes the devices of a running one.
    await this.start(owner, design, 'generate', [], actor, {
      devices: devices as Prisma.InputJsonValue,
    });
  }

  /**
   * #863 (ADR-0084): the devices a Generate draws for — the request's, with
   * unique names; else the project's presets, or the built-in devices.
   */
  private async devicesFor(
    projectId: string,
    request: DesignGenerateRequest,
  ): Promise<ViewportPreset[]> {
    if (request.devices === undefined) {
      return projectViewports(this.prisma, projectId);
    }
    const devices = viewportPresetsSchema.safeParse(request.devices);
    if (!devices.success) {
      throw designError(
        400,
        DESIGN_ERROR.invalidArgs,
        z.prettifyError(devices.error),
      );
    }
    return devices.data;
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
      select: { id: true, _count: { select: { frames: true } } },
    });
    if (!revision) {
      throw designError(
        400,
        DESIGN_ERROR.invalidArgs,
        'The revision is not a revision of this design',
      );
    }
    // #441: a revision stored before frames has one, its `html`.
    const frame = request.frame ?? 0;
    if (frame >= Math.max(revision._count.frames, 1)) {
      throw designError(
        400,
        DESIGN_ERROR.invalidArgs,
        'The frame is not a frame of this revision',
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
        frame,
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
    // #752 A1: the profile learns from it in the background; queuing never
    // fails the approval, and the approval never waits on the learn.
    await this.learner.request(design.id, revision.id);
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
          stack: true,
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
      } else if ('stackId' in key) {
        if (design.stack) {
          this.store.publishStackDesign(design.stack.projectId, key.stackId);
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
    design: Pick<TaskDesign, 'planId' | 'taskKey' | 'cardId' | 'stackId'>,
  ): DesignKey | null {
    if (design.cardId !== null) return { cardId: design.cardId };
    if (design.stackId !== null) return { stackId: design.stackId };
    if (design.planId !== null && design.taskKey !== null) {
      return { planId: design.planId, taskKey: design.taskKey };
    }
    return null;
  }

  private async startWaiting(
    design: TaskDesign & {
      plan: Plan | null;
      card: (BoardCard & { _count: { rounds: number } }) | null;
      stack: BoardStack | null;
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
    if ('stackId' in key) {
      if (!design.stack) return false;
      return this.stackTurns.chain(key.stackId, batch, w.userId);
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
    claim: Prisma.TaskDesignUpdateManyMutationInput = {},
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
    // The busy status is claimed before the profile check, from the status
    // read at rest: of two Generates at once only one passes, and the other's
    // failure never settles the winner's running turn.
    const claimed = await this.prisma.taskDesign.updateMany({
      where: { id: design.id, status: design.status },
      data: { ...claim, status: busyStatusOf(mode), busySince: new Date() },
    });
    if (claimed.count === 0) throw busy();
    let readiness: ProfileReadiness;
    try {
      readiness = await this.profiles.ensureFresh(project, caller, {
        designId: design.id,
        mode,
        userId: actor.userId,
      });
    } catch (error) {
      await settleDesign(this.prisma, owner.key);
      throw error;
    }
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

  /**
   * #833 D7: Complete — the repair turn by hand, for every variant whose
   * latest revision does not follow its template. It draws from the profile
   * those revisions were drawn from: a repair fixes the frames, not the style.
   */
  private async completeOf(
    owner: DesignOwner,
    actor: PlanActor,
  ): Promise<void> {
    const design = await this.drawable(owner);
    const revisions = await this.prisma.designRevision.findMany({
      where: { designId: design.id, archived: false },
      orderBy: { revision: 'desc' },
      select: { id: true, variant: true, conformance: true },
    });
    const latest = new Map<number, (typeof revisions)[number]>();
    for (const r of revisions)
      if (!latest.has(r.variant)) latest.set(r.variant, r);
    const off = [...latest.values()].filter(
      (r) => conformanceOfRow(r.conformance)?.ok === false,
    );
    const batch = completeBatchOf(
      off.map((r) => r.variant),
      design.profileId,
    );
    if (!batch) {
      throw designError(
        409,
        DESIGN_ERROR.invalidArgs,
        'Every variant follows its template; there is nothing to complete',
      );
    }
    await owner.assertIdle();
    const project = await this.store.project(owner.projectId);
    this.commands.assertServed(
      project.runnerId,
      RUNNER_FEATURE_COMMANDS.design,
    );
    const claimed = await this.prisma.taskDesign.updateMany({
      where: { id: design.id, status: design.status },
      data: { status: busyStatusOf('revise'), busySince: new Date() },
    });
    if (claimed.count === 0) throw busy();
    owner.publish();
    let turnId: string;
    try {
      turnId = await owner.runTurn(batch, callerOf(actor));
    } catch (error) {
      await settleDesign(this.prisma, owner.key);
      owner.publish();
      throw error;
    }
    await this.audit.record({
      ...actor.ctx,
      action: 'design.completed',
      target: owner.target,
      projectId: owner.projectId,
      after: {
        ...owner.label,
        revisions: off.map((r) => r.id),
        variants: off.map((r) => r.variant),
        turnId,
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
      label: { task: key },
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
        // #322 D6: an approved design is in the card's assessed input.
        await this.assessor.request(card.id);
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
   * #480: a stack's shared design. It changes until it is approved; approving
   * closes its design worktree and lifts the gate on the stack's cards.
   */
  private async stackOwner(
    projectId: string,
    number: number,
  ): Promise<DesignOwner> {
    const stack = await this.stack(projectId, number);
    return {
      kind: 'stack',
      key: { stackId: stack.id },
      projectId,
      target: { type: 'board_stack', id: stack.id },
      label: { stack: number },
      gate: async () => {},
      assertIdle: async () => {
        const active = await this.prisma.planTurn.count({
          where: { stackId: stack.id, phase: { in: ['queued', 'running'] } },
        });
        if (active > 0) {
          throw plannerError(
            409,
            PLANNER_ERROR.turnInProgress,
            'A design turn of this stack is queued or running',
          );
        }
      },
      runTurn: (batch, caller) => this.stackTurns.start(stack, batch, caller),
      onApproved: async (_design, actor) => {
        await this.stackTurns.close(stack, actor);
        // Every card of the stack may run now: their faces change.
        this.store.publishStackDesign(projectId, stack.id);
      },
      publish: () => this.store.publishStackDesign(projectId, stack.id),
    };
  }

  private async stack(projectId: string, number: number): Promise<BoardStack> {
    const stack = await this.prisma.boardStack.findUnique({
      where: { projectId_number: { projectId, number } },
    });
    if (!stack) {
      throw designError(404, DESIGN_ERROR.notFound, 'Stack not found');
    }
    return stack;
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
          // #443: this failure is the design's, not Auto-run when ready's.
          autoRunAfter: null,
          autoRunStack: null,
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
