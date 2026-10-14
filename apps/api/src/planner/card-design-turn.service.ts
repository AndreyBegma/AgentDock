import { randomUUID } from 'node:crypto';
import { cardLabel, PLANNER_ERROR } from '@agentdock/shared';
import {
  ORCHESTRATOR_DEFAULTS,
  PLAN_TURN_DEFAULT_TIMEOUT_SEC,
  type PlanTurnArgs,
  type PlanTurnSession,
  planTurnArgsSchema,
} from '@agentdock/shared/protocol';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { BoardCard, Prisma } from '@prisma/client';
import { z } from 'zod';
import { SYSTEM_ACTOR, systemActorFor } from '../audit/audit.types';
import { BudgetGate } from '../budgets/budget-gate';
import { PrismaService } from '../database/prisma.service';
import { cardDesignPrompt } from '../design/design-prompt';
import type { DesignTurnPlan } from '../design/design-rules';
import { cardDesignTaskKey, loadDesignPrompt } from '../design/design-store';
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

/** A turn whose session exists on the runner: it produced output, or succeeded. */
const sessionStarted: Prisma.PlanTurnWhereInput = {
  OR: [{ phase: 'succeeded' }, { resultText: { not: null } }],
};

/**
 * A board card's design turns (#243 D2, D4; ADR-0025). Each is a `runs` row
 * of kind `plan` and a `plan_turns` row owned by the card, sent as the
 * unchanged runner command `plan.turn` with `planId = card.id` — the runner
 * keeps a read-only worktree for the card as it does for a plan. The session
 * is the card's `designSessionId`: `--session-id` until it exists, then
 * `--resume`. One turn per card at a time; `PlanTurnProjector` applies the
 * results and starts the next variant of a batch.
 */
@Injectable()
export class CardDesignTurnService {
  private readonly logger = new Logger(CardDesignTurnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: PlanStore,
    private readonly commands: PlannerCommands,
    private readonly instructions: PlannerInstructionsService,
    @Optional() private readonly budgets?: BudgetGate,
  ) {}

  /** One design turn: one variant of the card's design. Returns the turn id. */
  async start(
    card: BoardCard,
    batch: DesignTurnPlan,
    caller: PlanCaller,
  ): Promise<string> {
    const project = await this.store.project(card.projectId);
    const profile = await this.store.profile(project);
    this.commands.assertReady(project.runnerId, 'plan.turn');
    await this.budgets?.assertAllowed({
      projectId: card.projectId,
      userId: caller.userId,
    });
    const design = await this.prisma.taskDesign.findUnique({
      where: { cardId: card.id },
      select: { id: true, variantCount: true, skills: true },
    });
    if (!design) {
      throw plannerError(
        409,
        PLANNER_ERROR.invalidArgs,
        'A design turn needs the card design',
      );
    }
    const [context, instructions, settings, session] = await Promise.all([
      loadDesignPrompt(this.prisma, project, design, batch),
      this.instructions.effective(card.projectId),
      this.prisma.projectOrchestratorSettings.findUnique({
        where: { projectId: card.projectId },
        select: { model: true },
      }),
      this.session(card),
    ]);
    const prompt = cardDesignPrompt({
      instructions: instructions.body,
      card: { number: card.number, title: card.title, body: card.body },
      taskKey: cardDesignTaskKey(card.number),
      design: context,
    });
    const model = card.model ?? settings?.model ?? ORCHESTRATOR_DEFAULTS.model;
    const draft = {
      planId: card.id,
      projectId: card.projectId,
      root: project.rootPath,
      base: project.base,
      session,
      prompt,
      profileKey: profile.key,
      model,
      timeoutSec: PLAN_TURN_DEFAULT_TIMEOUT_SEC,
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
      // Serializes design turn starts of one card: one turn at a time.
      await tx.$queryRaw`SELECT id FROM board_cards WHERE id = ${card.id} FOR UPDATE`;
      const active = await tx.planTurn.findFirst({
        where: { cardId: card.id, phase: { in: [...ACTIVE] } },
        select: { id: true },
      });
      if (active) {
        throw plannerError(
          409,
          PLANNER_ERROR.turnInProgress,
          'A design turn of this card is queued or running',
        );
      }
      if (card.designSessionId === null) {
        await tx.boardCard.update({
          where: { id: card.id },
          data: { designSessionId: session.id },
        });
      }
      const now = new Date();
      const run = await tx.run.create({
        data: {
          kind: 'plan',
          projectId: card.projectId,
          title: `Design · ${cardLabel(card.number)} v${batch.variant}`,
          runtime: profile.runtime,
          model,
          profileKey: profile.key,
          args: { cardId: card.id, action: 'design', design: batch },
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
          cardId: card.id,
          runId: run.id,
          action: 'design',
          authorId: caller.userId,
          input: {},
        },
        select: { id: true },
      });
      return { turnId: turn.id, runId: run.id };
    });
    await this.store.publishRun(card.projectId, runId);

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
      return turnId;
    } catch (error) {
      if (!(error instanceof PlannerFailure)) throw error;
      // No answer: the runner may have started it; its events settle the turn.
      if (error.code !== PLANNER_ERROR.runnerTimeout) {
        await this.store.settleTurn(turnId, {
          phase: 'failed',
          error: error.message,
        });
        await this.store.publishRun(card.projectId, runId);
      }
      throw error;
    }
  }

  /**
   * The next design turn of a batch, or the first after a profile build,
   * for the person who asked for it. False when it did not start — the
   * caller settles the design.
   */
  async chain(
    cardId: string,
    batch: DesignTurnPlan,
    authorId: string | null,
  ): Promise<boolean> {
    try {
      const card = await this.prisma.boardCard.findUniqueOrThrow({
        where: { id: cardId },
      });
      await this.start(card, batch, {
        userId: authorId,
        role: 'operator',
        ctx: { actor: authorId ? systemActorFor(authorId) : SYSTEM_ACTOR },
      });
      return true;
    } catch (error) {
      this.logger.warn(
        `card ${cardId}: design turn of variant ${batch.variant} not started: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /**
   * `plan.close {planId: card.id}`, best effort (#243 D2): the runner drops
   * the card's design worktree, cancelling a turn still running in it.
   */
  async close(
    card: { id: string; projectId: string },
    caller: Pick<PlanCaller, 'role' | 'ctx'>,
  ): Promise<void> {
    try {
      const project = await this.store.project(card.projectId);
      const result = await this.commands.send(
        project.runnerId,
        'plan.close',
        { planId: card.id, projectId: card.projectId },
        { role: caller.role, ctx: caller.ctx },
      );
      if (result.status === 'error') {
        throw plannerFailureOf('plan.close', result.error);
      }
      if (result.status !== 'ok') {
        this.logger.warn(`card ${card.id}: plan.close ${result.status}`);
      }
    } catch (error) {
      if (!(error instanceof PlannerFailure)) throw error;
      this.logger.warn(`card ${card.id}: plan.close: ${error.message}`);
    }
  }

  /** `--session-id` until the card's design session exists, then `--resume`. */
  private async session(card: BoardCard): Promise<PlanTurnSession> {
    if (card.designSessionId === null) {
      return { id: randomUUID(), resume: false };
    }
    const started = await this.prisma.planTurn.count({
      where: { cardId: card.id, ...sessionStarted },
    });
    return { id: card.designSessionId, resume: started > 0 };
  }
}
