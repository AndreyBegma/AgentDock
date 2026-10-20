import { randomUUID } from 'node:crypto';
import {
  cardLabel,
  DESIGN_ERROR,
  PLANNER_ERROR,
  stackLabel,
} from '@nautelle/shared';
import {
  PLAN_TURN_DEFAULT_TIMEOUT_SEC,
  type PlanTurnArgs,
  type PlanTurnSession,
  planTurnArgsSchema,
} from '@nautelle/shared/protocol';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { BoardStack } from '@prisma/client';
import { z } from 'zod';
import { SYSTEM_ACTOR, systemActorFor } from '../audit/audit.types';
import { defaultCardModel } from '../board/launch-choice';
import { BudgetGate } from '../budgets/budget-gate';
import { PrismaService } from '../database/prisma.service';
import { designError } from '../design/design-error';
import { stackDesignPrompt } from '../design/design-prompt';
import type { DesignTurnPlan } from '../design/design-rules';
import { loadDesignPrompt, stackDesignTaskKey } from '../design/design-store';
import type { NoProfileFailure } from '../readiness';
import { TokenSaverService } from '../token-saver/token-saver.service';
import { PlanStore } from './plan-store';
import type { PlanCaller } from './plan-turn.service';
import {
  PlannerCommands,
  plannerFailureOf,
  plannerOutput,
} from './planner-commands';
import { PlannerFailure, plannerError } from './planner-error';
import { PlannerInstructionsService } from './planner-instructions.service';

const ACTIVE = ['queued', 'running'] as const;

const noProfile: NoProfileFailure = (details, message) =>
  designError(422, DESIGN_ERROR.noProfile, message, details);

/**
 * A stack's design turns (#480, ADR-0044) — the same as a card's (#243 D2):
 * a `runs` row of kind `plan` and a `plan_turns` row owned by the stack, sent
 * as the unchanged runner command `plan.turn` with `planId = stack.id`, so
 * the runner keeps a read-only worktree for the stack. The session is the
 * stack's `designSessionId`. A stack has no launch choice of its own: its
 * turns run with the project's profile and model.
 */
@Injectable()
export class StackDesignTurnService {
  private readonly logger = new Logger(StackDesignTurnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: PlanStore,
    private readonly commands: PlannerCommands,
    private readonly instructions: PlannerInstructionsService,
    private readonly tokenSaver: TokenSaverService,
    @Optional() private readonly budgets?: BudgetGate,
  ) {}

  /** One design turn: one variant of the stack's design. Returns the turn id. */
  async start(
    stack: BoardStack,
    batch: DesignTurnPlan,
    caller: PlanCaller,
  ): Promise<string> {
    const project = await this.store.project(stack.projectId);
    const profile = await this.store.profile(project, undefined, noProfile);
    this.commands.assertReady(project.runnerId, 'plan.turn');
    await this.budgets?.assertAllowed({
      projectId: stack.projectId,
      userId: caller.userId,
    });
    const design = await this.prisma.taskDesign.findUnique({
      where: { stackId: stack.id },
      select: { id: true, variantCount: true, skills: true },
    });
    if (!design) {
      throw plannerError(
        409,
        PLANNER_ERROR.invalidArgs,
        'A design turn needs the stack design',
      );
    }
    const [context, instructions, settings, session, stages] =
      await Promise.all([
        loadDesignPrompt(this.prisma, project, design, batch),
        this.instructions.effective(stack.projectId),
        this.prisma.projectOrchestratorSettings.findUnique({
          where: { projectId: stack.projectId },
          select: { model: true },
        }),
        this.session(stack, batch),
        this.prisma.boardStackStage.findMany({
          where: { stackId: stack.id },
          orderBy: { position: 'asc' },
          include: {
            cards: {
              orderBy: [{ position: 'asc' }, { number: 'asc' }],
              select: { number: true, title: true },
            },
          },
        }),
      ]);
    const prompt = stackDesignPrompt({
      instructions: instructions.body,
      stack: {
        number: stack.number,
        title: stack.title,
        body: stack.body,
        stages: stages.map((s) => ({
          title: s.title,
          cards: s.cards.map((c) => `${cardLabel(c.number)}: ${c.title}`),
        })),
      },
      taskKey: stackDesignTaskKey(stack.number),
      design: context,
    });
    const model = defaultCardModel(undefined, settings?.model);
    const saver = await this.tokenSaver.launch(stack.projectId);
    const draft = {
      planId: stack.id,
      projectId: stack.projectId,
      root: project.rootPath,
      base: project.base,
      session,
      prompt,
      profileKey: profile.key,
      model,
      timeoutSec: PLAN_TURN_DEFAULT_TIMEOUT_SEC,
      ...saver.args,
    };
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
      // Serializes design turn starts of one stack: one turn at a time.
      await tx.$queryRaw`SELECT id FROM board_stacks WHERE id = ${stack.id} FOR UPDATE`;
      const active = await tx.planTurn.findFirst({
        where: { stackId: stack.id, phase: { in: [...ACTIVE] } },
        select: { id: true },
      });
      if (active) {
        throw plannerError(
          409,
          PLANNER_ERROR.turnInProgress,
          'A design turn of this stack is queued or running',
        );
      }
      if (stack.designSessionId === null) {
        await tx.boardStack.update({
          where: { id: stack.id },
          data: { designSessionId: session.id },
        });
      }
      const now = new Date();
      const run = await tx.run.create({
        data: {
          kind: 'plan',
          projectId: stack.projectId,
          title: `Design · ${stackLabel(stack.number)} v${batch.variant}`,
          runtime: profile.runtime,
          model,
          profileKey: profile.key,
          args: { stackId: stack.id, action: 'design', design: batch },
          tokenSaver: saver.on,
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
          stackId: stack.id,
          runId: run.id,
          action: 'design',
          authorId: caller.userId,
          input: {},
        },
        select: { id: true },
      });
      return { turnId: turn.id, runId: run.id };
    });
    await this.store.publishRun(stack.projectId, runId);

    const args: PlanTurnArgs = { ...valid.data, turnId, runId };
    try {
      const output = plannerOutput(
        'plan.turn',
        await this.commands.send(project.runnerId, 'plan.turn', args, {
          role: caller.role,
          ctx: caller.ctx,
          auditArgs: { ...args, prompt: `<${prompt.length} chars>` },
        }),
      );
      await this.prisma.planTurn.updateMany({
        where: { id: turnId, phase: 'queued' },
        data: { phase: output.phase },
      });
      return turnId;
    } catch (error) {
      if (!(error instanceof PlannerFailure)) throw error;
      if (error.code !== PLANNER_ERROR.runnerTimeout) {
        await this.store.settleTurn(turnId, {
          phase: 'failed',
          error: error.message,
        });
        await this.store.publishRun(stack.projectId, runId);
      }
      throw error;
    }
  }

  /** The next design turn of a batch, or the first after a profile build. */
  async chain(
    stackId: string,
    batch: DesignTurnPlan,
    authorId: string | null,
  ): Promise<boolean> {
    try {
      const stack = await this.prisma.boardStack.findUniqueOrThrow({
        where: { id: stackId },
      });
      await this.start(stack, batch, {
        userId: authorId,
        role: 'operator',
        ctx: { actor: authorId ? systemActorFor(authorId) : SYSTEM_ACTOR },
      });
      return true;
    } catch (error) {
      this.logger.warn(
        `stack ${stackId}: design turn of variant ${batch.variant} not started: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /** `plan.close {planId: stack.id}`, best effort: the runner drops the stack's design worktree. */
  async close(
    stack: { id: string; projectId: string },
    caller: Pick<PlanCaller, 'role' | 'ctx'>,
  ): Promise<void> {
    try {
      const project = await this.store.project(stack.projectId);
      const result = await this.commands.send(
        project.runnerId,
        'plan.close',
        { planId: stack.id, projectId: stack.projectId },
        { role: caller.role, ctx: caller.ctx },
      );
      if (result.status === 'error') {
        throw plannerFailureOf('plan.close', result.error);
      }
    } catch (error) {
      if (!(error instanceof PlannerFailure)) throw error;
      this.logger.warn(`stack ${stack.id}: plan.close: ${error.message}`);
    }
  }

  /**
   * `--session-id` until the stack's design session exists, then `--resume`.
   * #628: a revise runs in a session of its own, as a card's does.
   */
  private async session(
    stack: BoardStack,
    batch: DesignTurnPlan,
  ): Promise<PlanTurnSession> {
    if (stack.designSessionId === null || batch.mode === 'revise') {
      return { id: randomUUID(), resume: false };
    }
    const started = await this.prisma.planTurn.count({
      where: {
        stackId: stack.id,
        OR: [{ phase: 'succeeded' }, { resultText: { not: null } }],
      },
    });
    return { id: stack.designSessionId, resume: started > 0 };
  }
}
