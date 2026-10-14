import { randomUUID } from 'node:crypto';
import {
  PLANNER_ERROR,
  type PlanTurnAction,
  type PlanTurnInput,
  type Role,
} from '@agentdock/shared';
import {
  PLAN_TURN_DEFAULT_TIMEOUT_SEC,
  type PlanTurnArgs,
  type PlanTurnSession,
  planTurnArgsSchema,
} from '@agentdock/shared/protocol';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Plan, PlanTask, Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { SYSTEM_ACTOR, systemActorFor } from '../audit/audit.types';
import { BudgetGate } from '../budgets/budget-gate';
import { PrismaService } from '../database/prisma.service';
import { TALKABLE_STATUSES } from './plan-apply';
import { questionsOf } from './plan-mapper';
import { assemblePrompt } from './plan-prompt';
import { PlanStore } from './plan-store';
import { PlannerCommands, plannerOutput } from './planner-commands';
import { PlannerFailure, plannerError } from './planner-error';

/** Who acts: a person on a route, or the system chaining a turn for its author. */
export interface PlanCaller {
  /** The person the turn runs for; their budget counts it (#28 D3). */
  userId: string | null;
  role: Role;
  ctx: AuditContext;
}

interface TurnSpec {
  action: PlanTurnAction;
  task: PlanTask | null;
  input: PlanTurnInput;
}

const turnInProgress = () =>
  plannerError(
    409,
    PLANNER_ERROR.turnInProgress,
    'A turn of this plan is queued or running',
  );

/** A turn whose session exists on the runner: it produced output, or succeeded. */
const sessionStarted: Prisma.PlanTurnWhereInput = {
  OR: [{ phase: 'succeeded' }, { resultText: { not: null } }],
};

const ACTIVE = ['queued', 'running'] as const;

/**
 * Plan turns (D3, D7, D14, D16). A turn is a `runs` row of kind `plan` and a
 * `plan_turns` row; the runner runs `claude -p` once and reports the result
 * as `plan_turn.*` events, which `PlanTurnProjector` applies. One turn per
 * plan at a time.
 */
@Injectable()
export class PlanTurnService {
  private readonly logger = new Logger(PlanTurnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: PlanStore,
    private readonly commands: PlannerCommands,
    private readonly audit: AuditService,
    @Optional() private readonly budgets?: BudgetGate,
  ) {}

  /** `POST …/turns`: the next plan-level round — clarify, or decompose when that failed. */
  async planTurn(
    plan: Plan,
    input: PlanTurnInput,
    caller: PlanCaller,
  ): Promise<string> {
    this.store.assertOpen(plan);
    let action: PlanTurnAction;
    if (plan.status === 'clarifying') {
      action = 'clarify';
    } else if (
      plan.status === 'drafting' &&
      (await this.store.currentTasks(this.prisma, plan)).length === 0
    ) {
      action = 'decompose';
    } else {
      throw plannerError(
        409,
        PLANNER_ERROR.invalidArgs,
        'The plan is decomposed: talk a task through, or revise the plan',
      );
    }
    return this.run(plan, { action, task: null, input }, caller);
  }

  /** `POST …/tasks/:key/turns`: a grill round of one task (D7). */
  async taskTurn(
    plan: Plan,
    key: string,
    input: PlanTurnInput,
    caller: PlanCaller,
  ): Promise<string> {
    this.store.assertOpen(plan);
    const task = await this.store.task(plan, key);
    if (!TALKABLE_STATUSES.includes(task.status)) {
      throw plannerError(
        409,
        PLANNER_ERROR.invalidArgs,
        `Task ${key} is ${task.status}; ask for a rewrite to talk it through again`,
      );
    }
    return this.run(plan, { action: 'grill', task, input }, caller);
  }

  /** D9: one plan-level turn with every rewrite comment. */
  async revise(plan: Plan, caller: PlanCaller): Promise<string> {
    this.store.assertOpen(plan);
    const tasks = await this.store.currentTasks(this.prisma, plan);
    const comments = tasks.filter((t) => t.status === 'rewrite_requested');
    if (plan.status !== 'reviewing' || comments.length === 0) {
      throw plannerError(
        409,
        PLANNER_ERROR.invalidArgs,
        'Revise needs a decomposed plan with a rewrite requested',
      );
    }
    const turnId = await this.run(
      plan,
      { action: 'revise', task: null, input: {} },
      caller,
    );
    await this.audit.record({
      ...caller.ctx,
      action: 'plan.revised',
      target: { type: 'plan', id: plan.id },
      projectId: plan.projectId,
      after: {
        fromVersion: plan.version,
        rewrites: comments.map((t) => t.key),
        turnId,
      },
      result: 'ok',
    });
    return turnId;
  }

  /** A failed turn again: its action, input and scope; no audit of its own. */
  async retry(plan: Plan, turnId: string, caller: PlanCaller): Promise<string> {
    this.store.assertOpen(plan);
    const turn = await this.prisma.planTurn.findFirst({
      where: { id: turnId, planId: plan.id },
      include: { task: { select: { key: true } } },
    });
    if (!turn) {
      throw plannerError(404, PLANNER_ERROR.notFound, 'Turn not found');
    }
    if (turn.phase !== 'failed') {
      throw plannerError(
        409,
        PLANNER_ERROR.turnNotFailed,
        `The turn is ${turn.phase}; only a failed turn is retried`,
      );
    }
    const task = turn.task ? await this.store.task(plan, turn.task.key) : null;
    const input = (turn.input ?? {}) as PlanTurnInput;
    return this.run(plan, { action: turn.action, task, input }, caller);
  }

  /** Kills the turn's session; the runner reports `cancelled`. */
  async cancel(plan: Plan, turnId: string, caller: PlanCaller): Promise<void> {
    const turn = await this.prisma.planTurn.findFirst({
      where: { id: turnId, planId: plan.id },
      select: { phase: true },
    });
    if (!turn) {
      throw plannerError(404, PLANNER_ERROR.notFound, 'Turn not found');
    }
    if (!(ACTIVE as readonly string[]).includes(turn.phase)) {
      throw plannerError(
        409,
        PLANNER_ERROR.invalidArgs,
        `The turn already ended ${turn.phase}`,
      );
    }
    const project = await this.store.project(plan.projectId);
    plannerOutput(
      'plan.cancel',
      await this.commands.send(
        project.runnerId,
        'plan.cancel',
        { planId: plan.id, turnId },
        { role: caller.role, ctx: caller.ctx },
      ),
    );
  }

  /**
   * A turn the API starts on its own (D7): `write` after a grill is done,
   * `decompose` after clarify is done. It runs for the author of the turn
   * that led to it; a refusal is logged, and a started turn that fails can be
   * retried from the page.
   */
  async chain(
    planId: string,
    action: Extract<PlanTurnAction, 'write' | 'decompose'>,
    taskId: string | null,
    authorId: string | null,
  ): Promise<void> {
    try {
      const plan = await this.prisma.plan.findUniqueOrThrow({
        where: { id: planId },
      });
      const task = taskId
        ? await this.prisma.planTask.findUniqueOrThrow({
            where: { id: taskId },
          })
        : null;
      await this.run(
        plan,
        { action, task, input: {} },
        {
          userId: authorId,
          role: 'operator',
          ctx: { actor: authorId ? systemActorFor(authorId) : SYSTEM_ACTOR },
        },
      );
    } catch (error) {
      this.logger.warn(
        `plan ${planId}: chained ${action} not started: ${(error as Error).message}`,
      );
    }
  }

  private async run(
    plan: Plan,
    spec: TurnSpec,
    caller: PlanCaller,
  ): Promise<string> {
    const project = await this.store.project(plan.projectId);
    const profile = await this.store.profile(project, plan.profileKey);
    this.commands.assertReady(project.runnerId, 'plan.turn');
    // Spec 28 D7, D11 and D14: a budget that refuses runs refuses a turn.
    await this.budgets?.assertAllowed({
      projectId: plan.projectId,
      userId: caller.userId,
    });

    const [instructions, tasks, session] = await Promise.all([
      this.prisma.plannerInstructions.findUniqueOrThrow({
        where: { id: plan.instructionsId },
        select: { body: true },
      }),
      this.store.currentTasks(this.prisma, plan),
      this.session(plan, spec.task),
    ]);
    const prompt = assemblePrompt({
      instructions: instructions.body,
      action: spec.action,
      brief: plan.brief,
      plan: { title: plan.title, mode: plan.mode, version: plan.version },
      tasks: tasks.map((t) => ({
        key: t.key,
        kind: t.kind,
        title: t.title,
        summary: t.summary,
        dependsOn: t.dependsOn,
        status: t.status,
        frozen: t.frozen,
        questions: questionsOf(t.questions),
        document: t.document,
        rewriteComment: t.rewriteComment,
      })),
      taskKey: spec.task?.key,
      round:
        spec.action === 'clarify'
          ? await this.store.planRound(plan.id)
          : spec.task
            ? questionsOf(spec.task.questions)
            : [],
      input: spec.input,
    });
    const draft = {
      planId: plan.id,
      projectId: plan.projectId,
      root: project.rootPath,
      base: project.base,
      session,
      prompt,
      profileKey: profile.key,
      model: plan.model,
      timeoutSec: PLAN_TURN_DEFAULT_TIMEOUT_SEC,
    };
    // The ids are not known yet; any valid id checks the rest.
    const valid = planTurnArgsSchema.safeParse({
      ...draft,
      turnId: 'pending',
      runId: 'pending',
    });
    if (!valid.success) {
      throw plannerError(
        400,
        PLANNER_ERROR.invalidArgs,
        z.prettifyError(valid.error),
      );
    }

    const { turnId, runId } = await this.prisma.$transaction(async (tx) => {
      // Serializes turn starts of one plan: one turn at a time.
      await tx.$queryRaw`SELECT id FROM plans WHERE id = ${plan.id} FOR UPDATE`;
      const active = await tx.planTurn.findFirst({
        where: { planId: plan.id, phase: { in: [...ACTIVE] } },
        select: { id: true },
      });
      if (active) throw turnInProgress();
      if (spec.task && spec.task.sessionId === null) {
        await tx.planTask.update({
          where: { id: spec.task.id },
          data: { sessionId: session.id },
        });
      }
      if (spec.action === 'decompose' && plan.status === 'clarifying') {
        await tx.plan.update({
          where: { id: plan.id },
          data: { status: 'drafting' },
        });
      }
      const now = new Date();
      const run = await tx.run.create({
        data: {
          kind: 'plan',
          projectId: plan.projectId,
          title: spec.task
            ? `Plan ${spec.action}: ${spec.task.key}`
            : `Plan ${spec.action}`,
          runtime: profile.runtime,
          model: plan.model,
          profileKey: profile.key,
          args: {
            planId: plan.id,
            action: spec.action,
            ...(spec.task ? { taskKey: spec.task.key } : {}),
          },
          status: 'running',
          triggeredByType: 'user',
          triggeredById: caller.userId,
          startedAt: now,
          updatedAt: now,
        },
        select: { id: true },
      });
      const turn = await tx.planTurn.create({
        data: {
          planId: plan.id,
          taskId: spec.task?.id ?? null,
          runId: run.id,
          action: spec.action,
          authorId: caller.userId,
          input: spec.input as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      return { turnId: turn.id, runId: run.id };
    });
    this.store.publish(plan.projectId, plan.id);

    const args: PlanTurnArgs = { ...valid.data, turnId, runId };
    try {
      const output = plannerOutput(
        'plan.turn',
        await this.commands.send(project.runnerId, 'plan.turn', args, {
          role: caller.role,
          ctx: caller.ctx,
          // The prompt is data the audit log need not repeat in full.
          auditArgs: { ...args, prompt: `<${prompt.length} chars>` },
        }),
      );
      // Events may already have moved it on; never step back.
      await this.prisma.planTurn.updateMany({
        where: { id: turnId, phase: 'queued' },
        data: { phase: output.phase },
      });
      this.store.publish(plan.projectId, plan.id);
      return turnId;
    } catch (error) {
      if (!(error instanceof PlannerFailure)) throw error;
      // No answer: the runner may have started it; its events settle the turn.
      if (error.code !== PLANNER_ERROR.runnerTimeout) {
        await this.store.settleTurn(turnId, {
          phase: 'failed',
          error: error.message,
        });
        this.store.publish(plan.projectId, plan.id);
      }
      throw error;
    }
  }

  /**
   * D3. Plan-level: `--session-id` until the session exists, then `--resume`.
   * A task's first turn forks the plan session with an id the API chooses;
   * later ones resume the fork.
   */
  private async session(
    plan: Plan,
    task: PlanTask | null,
  ): Promise<PlanTurnSession> {
    if (!task) {
      const started = await this.prisma.planTurn.count({
        where: { planId: plan.id, taskId: null, ...sessionStarted },
      });
      return { id: plan.sessionId, resume: started > 0 };
    }
    const id = task.sessionId ?? randomUUID();
    const forked =
      task.sessionId !== null &&
      (await this.prisma.planTurn.count({
        where: { planId: plan.id, task: { key: task.key }, ...sessionStarted },
      })) > 0;
    return forked
      ? { id, resume: true }
      : { id, resume: true, forkFrom: plan.sessionId };
  }
}
