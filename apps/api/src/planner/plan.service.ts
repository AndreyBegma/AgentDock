import { randomUUID } from 'node:crypto';
import {
  type CreatePlanRequest,
  PLANNER_CONTRACT_VERSION,
  PLANNER_ERROR,
  PLANNER_TITLE_MAX,
  type PlanDetail,
  type PlanListView,
  type PlanReviewDecision,
  type PlanTaskVersionsView,
  type PlanVisibility,
  type Role,
} from '@agentdock/shared';
import {
  Injectable,
  Logger,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import type { Plan, PlanTaskStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { BudgetGate } from '../budgets/budget-gate';
import { PrismaService } from '../database/prisma.service';
import { designBlocks } from '../design/design-rules';
import { designSummaries } from '../design/design-store';
import { TextNormalizer } from '../text/text-normalizer';
import { TextOwners } from '../text/text-owners';
import { readablePlanWhere } from './plan-access';
import {
  blockingOpen,
  planInclude,
  questionsOf,
  toDetail,
  toSummary,
  toTaskView,
  toTurnView,
  turnInclude,
  userRef,
  userSelect,
} from './plan-mapper';
import { PlanStore } from './plan-store';
import { type PlanCaller, PlanTurnService } from './plan-turn.service';
import { toTaskVersionView, versionTurns } from './plan-versions';
import { PlannerCommands } from './planner-commands';
import { PlannerFailure, plannerError } from './planner-error';
import { PlannerInstructionsService } from './planner-instructions.service';
import { loadIssueViews } from './task-live';

/** A person on a plan route, as the guard resolved them. */
export interface PlanActor {
  userId: string;
  /** The effective project role. */
  role: Role;
  ctx: AuditContext;
}

export const callerOf = (actor: PlanActor): PlanCaller => ({
  userId: actor.userId,
  role: actor.role,
  ctx: actor.ctx,
});

/** D14: a plan runs on opus unless it says otherwise. */
const DEFAULT_MODEL = 'opus';

/** The brief's first line, cut to a title; decompose replaces it. */
export const titleOf = (brief: string): string => {
  const line =
    brief
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? 'Untitled plan';
  return line.length > PLANNER_TITLE_MAX
    ? `${line.slice(0, PLANNER_TITLE_MAX - 1)}…`
    : line;
};

const REVIEW_STATUS: Record<PlanReviewDecision, PlanTaskStatus> = {
  approve: 'approved',
  reject: 'rejected',
  rewrite: 'rewrite_requested',
};

/** Plans: create, read, review, share, archive (spec 172 "API", D1, D6, D12). */
@Injectable()
export class PlanService implements OnModuleInit {
  private readonly logger = new Logger(PlanService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: PlanStore,
    private readonly turns: PlanTurnService,
    private readonly commands: PlannerCommands,
    private readonly instructions: PlannerInstructionsService,
    private readonly audit: AuditService,
    private readonly text: TextNormalizer,
    private readonly textOwners: TextOwners,
    @Optional() private readonly budgets?: BudgetGate,
  ) {}

  /**
   * #271: the plan, its tasks' review comments and its turns' messages land
   * as the plan's live event; an English brief retitles a plan whose title
   * is still the brief's first line (D10).
   */
  onModuleInit(): void {
    this.textOwners.register('plan', {
      publish: (projectId, planId) => this.store.publish(projectId, planId),
      derive: async (tx, planId, applied) => {
        const brief = applied.find((f) => f.field === 'brief');
        if (!brief) return;
        await tx.plan.updateMany({
          where: { id: planId, title: titleOf(brief.original) },
          data: { title: titleOf(brief.english) },
        });
      },
    });
    const viaPlan =
      (find: (id: string) => Promise<{ planId: string | null } | null>) =>
      async (projectId: string, id: string) => {
        const row = await find(id);
        if (row?.planId) this.store.publish(projectId, row.planId);
      };
    this.textOwners.register('plan_task', {
      publish: viaPlan((id) =>
        this.prisma.planTask.findUnique({
          where: { id },
          select: { planId: true },
        }),
      ),
    });
    this.textOwners.register('plan_turn', {
      publish: viaPlan((id) =>
        this.prisma.planTurn.findUnique({
          where: { id },
          select: { planId: true },
        }),
      ),
    });
  }

  /**
   * A private plan and its first turn: `clarify` in dialogue mode,
   * `decompose` in batch mode (D2). What can be refused is refused before the
   * plan exists; a runner failure after that fails the turn, which the page
   * offers to retry.
   */
  async create(
    projectId: string,
    actor: PlanActor,
    request: CreatePlanRequest,
  ): Promise<PlanDetail> {
    const project = await this.store.project(projectId);
    const profile = await this.store.profile(project, request.profileKey);
    this.commands.assertReady(project.runnerId, 'plan.turn');
    await this.budgets?.assertAllowed({ projectId, userId: actor.userId });
    const instructions = await this.instructions.effective(projectId);

    const plan = await this.prisma.plan.create({
      data: {
        projectId,
        authorId: actor.userId,
        title: titleOf(request.brief),
        brief: request.brief,
        mode: request.mode,
        visibility: 'private',
        status: request.mode === 'dialogue' ? 'clarifying' : 'drafting',
        sessionId: randomUUID(),
        instructionsId: instructions.id,
        contractVersion: PLANNER_CONTRACT_VERSION,
        profileKey: profile.key,
        model: request.model ?? DEFAULT_MODEL,
      },
    });
    await this.audit.record({
      ...actor.ctx,
      action: 'plan.created',
      target: { type: 'plan', id: plan.id },
      projectId,
      after: {
        mode: plan.mode,
        model: plan.model,
        profileKey: plan.profileKey,
        instructionsId: plan.instructionsId,
      },
      result: 'ok',
    });
    // #271 D3: the first turn reads the brief as typed.
    await this.text.request(
      projectId,
      { ownerType: 'plan', ownerId: plan.id },
      [{ field: 'brief', text: plan.brief }],
      { authorId: actor.userId },
    );
    try {
      await this.turns.planTurn(plan, {}, callerOf(actor));
    } catch (error) {
      if (!(error instanceof PlannerFailure)) throw error;
      this.logger.warn(`plan ${plan.id}: first turn failed: ${error.message}`);
    }
    return this.detail(projectId, actor.userId, plan.id);
  }

  async list(projectId: string, userId: string): Promise<PlanListView> {
    const plans = await this.prisma.plan.findMany({
      where: { projectId, ...readablePlanWhere(userId) },
      include: planInclude,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });
    const planIds = plans.map((p) => p.id);
    const [tasks, latest] = await Promise.all([
      this.prisma.planTask.findMany({
        where: { planId: { in: planIds } },
        select: { planId: true, planVersion: true, status: true },
      }),
      // #213: each plan's newest turn, any scope — the first of its plan in this order.
      this.prisma.planTurn.findMany({
        where: { planId: { in: planIds } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        distinct: ['planId'],
        select: {
          id: true,
          planId: true,
          phase: true,
          error: true,
          createdAt: true,
          finishedAt: true,
        },
      }),
    ]);
    const latestOf = new Map(latest.map((t) => [t.planId, t]));
    return {
      items: plans.map((plan) =>
        toSummary(
          plan,
          tasks.filter(
            (t) => t.planId === plan.id && t.planVersion === plan.version,
          ),
          latestOf.get(plan.id) ?? null,
        ),
      ),
    };
  }

  async detail(
    projectId: string,
    userId: string,
    planId: string,
  ): Promise<PlanDetail> {
    const readable = await this.store.readable(userId, projectId, planId);
    const plan = await this.prisma.plan.findUniqueOrThrow({
      where: { id: readable.id },
      include: { ...planInclude, instructions: { select: { version: true } } },
    });
    const [tasks, turns, questions] = await Promise.all([
      this.store.currentTasks(this.prisma, plan),
      this.prisma.planTurn.findMany({
        where: { planId },
        include: turnInclude,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      plan.status === 'clarifying'
        ? this.store.planRound(planId)
        : Promise.resolve([]),
    ]);
    const [issueOf, designs] = await Promise.all([
      loadIssueViews(this.prisma, projectId, tasks),
      designSummaries(this.prisma, planId),
    ]);
    return toDetail({
      plan,
      tasks: tasks.map((t) =>
        toTaskView(t, issueOf(t), designs.get(t.key) ?? null),
      ),
      turns: turns.map(toTurnView),
      // Oldest first: the last is the newest (#213).
      latestTurn: turns.at(-1) ?? null,
      questions,
    });
  }

  /**
   * D9: the plan versions a task appeared in, oldest first, each with the
   * turn that produced it. Read through the same rule as the plan; a key no
   * version holds is 404.
   */
  async taskVersions(
    projectId: string,
    userId: string,
    planId: string,
    key: string,
  ): Promise<PlanTaskVersionsView> {
    const plan = await this.store.readable(userId, projectId, planId);
    const [rows, turns] = await Promise.all([
      this.prisma.planTask.findMany({
        where: { planId: plan.id, key },
        orderBy: { planVersion: 'asc' },
      }),
      this.prisma.planTurn.findMany({
        where: {
          planId: plan.id,
          action: { in: ['decompose', 'revise'] },
          phase: 'succeeded',
        },
        select: {
          id: true,
          action: true,
          author: userSelect,
          finishedAt: true,
          createdAt: true,
        },
      }),
    ]);
    if (rows.length === 0) {
      throw plannerError(404, PLANNER_ERROR.notFound, 'Task not found');
    }
    const byVersion = versionTurns(
      turns.map((t) => ({
        id: t.id,
        action: t.action === 'revise' ? 'revise' : 'decompose',
        author: userRef(t.author),
        finishedAt: t.finishedAt,
        createdAt: t.createdAt,
      })),
    );
    return {
      key,
      currentVersion: plan.version,
      versions: rows.map((row) =>
        toTaskVersionView(row, byVersion.get(row.planVersion) ?? null),
      ),
    };
  }

  /**
   * D6, D9: approve (refused while a blocking question is open), reject, or
   * ask for a rewrite with a comment. Refused while a revise turn runs, since
   * it reads the reviews.
   */
  async review(
    plan: Plan,
    key: string,
    decision: PlanReviewDecision,
    comment: string | undefined,
    actor: PlanActor,
  ): Promise<void> {
    this.store.assertOpen(plan);
    if (plan.status !== 'reviewing') {
      throw plannerError(
        409,
        PLANNER_ERROR.invalidArgs,
        'Tasks are reviewed once the plan is decomposed',
      );
    }
    const revising = await this.prisma.planTurn.count({
      where: {
        planId: plan.id,
        action: 'revise',
        phase: { in: ['queued', 'running'] },
      },
    });
    if (revising > 0) {
      throw plannerError(
        409,
        PLANNER_ERROR.turnInProgress,
        'The plan is being revised',
      );
    }
    const task = await this.store.task(plan, key);
    if (task.status === 'issued') {
      throw plannerError(
        409,
        PLANNER_ERROR.invalidArgs,
        `Task ${key} is already an issue`,
      );
    }
    const record = (result: 'ok' | 'denied', meta: object = {}) =>
      this.audit.record({
        ...actor.ctx,
        action: 'plan.task_reviewed',
        target: { type: 'plan', id: plan.id },
        projectId: plan.projectId,
        after: { key, decision, version: plan.version },
        result,
        meta,
      });
    if (
      decision === 'approve' &&
      (task.status === 'needs_talk' ||
        blockingOpen(questionsOf(task.questions)) > 0)
    ) {
      await record('denied', { reason: PLANNER_ERROR.needsTalk });
      throw plannerError(
        409,
        PLANNER_ERROR.needsTalk,
        `Task ${key} has a blocking question open`,
      );
    }
    if (decision === 'approve') {
      const design = await this.prisma.taskDesign.findUnique({
        where: { planId_taskKey: { planId: plan.id, taskKey: key } },
        select: { needed: true, status: true },
      });
      if (designBlocks(design)) {
        await record('denied', { reason: PLANNER_ERROR.designNotApproved });
        throw plannerError(
          409,
          PLANNER_ERROR.designNotApproved,
          `Task ${key} needs its design approved first`,
        );
      }
    }
    const text = comment?.trim() ?? '';
    if (decision === 'rewrite' && text === '') {
      throw plannerError(
        400,
        PLANNER_ERROR.invalidArgs,
        'A rewrite needs a comment',
      );
    }
    await this.prisma.planTask.update({
      where: { id: task.id },
      data: {
        status: REVIEW_STATUS[decision],
        rewriteComment: decision === 'rewrite' ? text : null,
      },
    });
    await this.touch(plan.id);
    await record('ok');
    this.store.publish(plan.projectId, plan.id);
    if (decision === 'rewrite') {
      await this.text.request(
        plan.projectId,
        { ownerType: 'plan_task', ownerId: task.id },
        [{ field: 'rewriteComment', text }],
        { authorId: actor.userId },
      );
    }
  }

  /** D12: only the author shares a plan, or takes it back while nothing was sent. */
  async setVisibility(
    plan: Plan,
    visibility: PlanVisibility,
    actor: PlanActor,
  ): Promise<void> {
    if (plan.authorId !== actor.userId) {
      throw plannerError(
        403,
        PLANNER_ERROR.forbidden,
        'Only the author changes who sees a plan',
      );
    }
    if (
      visibility === 'private' &&
      (plan.status === 'sending' || plan.status === 'sent')
    ) {
      throw plannerError(
        409,
        PLANNER_ERROR.planClosed,
        'A sent plan stays shared: its issues are public to the repository',
      );
    }
    if (plan.visibility === visibility) return;
    await this.prisma.plan.update({
      where: { id: plan.id },
      data: { visibility },
    });
    await this.audit.record({
      ...actor.ctx,
      action: 'plan.shared',
      target: { type: 'plan', id: plan.id },
      projectId: plan.projectId,
      before: { visibility: plan.visibility },
      after: { visibility },
      result: 'ok',
    });
    this.store.publish(plan.projectId, plan.id);
  }

  /**
   * The author or a project admin archives a plan: `plan.close` removes its
   * worktree. A runner that cannot take the command leaves it to the 14-day
   * idle cleanup (D15); the plan is archived either way.
   */
  async archive(plan: Plan, actor: PlanActor): Promise<void> {
    if (plan.authorId !== actor.userId && actor.role !== 'admin') {
      throw plannerError(
        403,
        PLANNER_ERROR.forbidden,
        'Only the author or a project admin archives a plan',
      );
    }
    if (plan.status === 'archived') return;
    const active = await this.prisma.planTurn.count({
      where: { planId: plan.id, phase: { in: ['queued', 'running'] } },
    });
    if (active > 0) {
      throw plannerError(
        409,
        PLANNER_ERROR.turnInProgress,
        'Cancel the running turn first',
      );
    }
    await this.close(plan, callerOf(actor));
    await this.prisma.plan.update({
      where: { id: plan.id },
      data: { status: 'archived' },
    });
    this.store.publish(plan.projectId, plan.id);
  }

  /** `plan.close`, best effort (D15). */
  async close(plan: Plan, caller: PlanCaller): Promise<void> {
    try {
      const project = await this.store.project(plan.projectId);
      const result = await this.commands.send(
        project.runnerId,
        'plan.close',
        { planId: plan.id, projectId: plan.projectId },
        { role: caller.role, ctx: caller.ctx },
      );
      if (result.status !== 'ok') {
        this.logger.warn(`plan ${plan.id}: plan.close ${result.status}`);
      }
    } catch (error) {
      if (!(error instanceof PlannerFailure)) throw error;
      this.logger.warn(`plan ${plan.id}: plan.close: ${error.message}`);
    }
  }

  private touch(planId: string) {
    return this.prisma.plan.update({
      where: { id: planId },
      data: { updatedAt: new Date() },
    });
  }
}
