import {
  BOARD_ERROR,
  type BoardStackDetail,
  type CardRoundPhase,
  cardLabel,
  isStackGated,
  type Role,
  type StackRunPause,
  stackLabel,
} from '@agentdock/shared';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { BoardStackRun } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { SYSTEM_ACTOR, systemActorFor } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { RunnerConnectHooks } from '../runners/runner-connect-hooks';
import { BoardCommands } from './board-commands';
import { BoardDependencies } from './board-dependencies.service';
import { autoRunFailureOf, boardError } from './board-error';
import { toSettingsView } from './board-mapper';
import { BoardRoundsService } from './board-rounds.service';
import { shippingAutoStart } from './board-shipping';
import { BoardStacks } from './board-stacks';
import { ACTIVE_PHASES, type BoardActor, BoardWork } from './board-work';

/** #652: how often a running stack run is re-evaluated without a card change. */
export const STACK_RUN_SWEEP_MS = 60_000;

/** #652: a round the run started that ended in one of these paused it. */
const FAILED_PHASES: ReadonlySet<CardRoundPhase> = new Set(['failed', 'ended']);

/** #652: refusals that leave a queued card queued — it waits, nothing failed. */
const WAITS_FOR_DEPENDENCY: ReadonlySet<string> = new Set([
  BOARD_ERROR.dependencyOpen,
  BOARD_ERROR.dependenciesUnmerged,
]);

const MESSAGE_MAX = 500;

/** What a tick reads of a running stack run. */
const RUN_INCLUDE = {
  stack: { select: { id: true, number: true } },
  cards: {
    select: {
      id: true,
      status: true,
      roundId: true,
      card: {
        select: {
          id: true,
          number: true,
          column: true,
          stage: { select: { position: true } },
          rounds: {
            orderBy: { round: 'desc' },
            take: 1,
            select: { id: true, phase: true },
          },
        },
      },
    },
  },
} as const;

type RunEntry = {
  id: string;
  status: 'queued' | 'waiting' | 'started';
  roundId: string | null;
  card: {
    id: string;
    number: number;
    column: string;
    stage: { position: number } | null;
    rounds: { id: string; phase: CardRoundPhase }[];
  };
};

/** The person who pressed Run stack, as the queued cards start. */
const actorOf = (run: Pick<BoardStackRun, 'startedById' | 'startedByRole'>) =>
  ({
    userId: run.startedById,
    role: (run.startedByRole === 'admin' ? 'admin' : 'operator') as Role,
    ctx: {
      actor:
        run.startedById !== null
          ? systemActorFor(run.startedById)
          : SYSTEM_ACTOR,
    },
  }) satisfies BoardActor;

/**
 * Run stack (#652): pressing it puts the stack's To Do cards in a persisted
 * queue (`board_stack_run_cards`). On every card change of the project — a
 * round finishing, a PR opening, a merge, an acceptance, a slot freeing —
 * the queue is re-evaluated: a card whose dependencies allow it under the
 * stacked-branch rules (`assertRunnable`) starts through
 * `BoardRoundsService.run`, in stage then number order, while the project
 * has room under `maxRunning`. A `max_running` refusal leaves it queued; any
 * other refusal, or a round the run started that fails, pauses the run until
 * a person presses Run stack again. Stop removes the queue and leaves running
 * cards alone. The queue survives a restart: bootstrap resumes it.
 */
@Injectable()
export class BoardStackRuns
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(BoardStackRuns.name);
  /** Each project's evaluation in flight; one at a time per project. */
  private readonly ticking = new Map<string, Promise<void>>();
  /** Projects changed while their evaluation ran: it runs once more. */
  private readonly again = new Set<string>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly work: BoardWork,
    private readonly rounds: BoardRoundsService,
    private readonly stacks: BoardStacks,
    private readonly dependencies: BoardDependencies,
    private readonly audit: AuditService,
    private readonly commands: BoardCommands,
    private readonly connectHooks: RunnerConnectHooks,
  ) {}

  onModuleInit(): void {
    this.work.onChanged((projectId) => {
      void this.nudge(projectId);
    });
    // A run waits while its runner is away; it goes on when the runner is back.
    this.connectHooks.register({
      name: 'board-stack-runs',
      connected: (runnerId) => this.resumeAll(runnerId),
    });
  }

  /** Resumes every running stack run, then sweeps them now and then. */
  onApplicationBootstrap(): void {
    if (!shippingAutoStart()) return;
    void this.resumeAll();
    this.timer = setInterval(() => void this.resumeAll(), STACK_RUN_SWEEP_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Every project with a running stack run — of `runnerId`, if given — is evaluated. */
  async resumeAll(runnerId?: string): Promise<void> {
    try {
      const runs = await this.prisma.boardStackRun.findMany({
        where: {
          state: 'running',
          ...(runnerId ? { stack: { project: { runnerId } } } : {}),
        },
        select: { stack: { select: { projectId: true } } },
      });
      const projects = new Set(runs.map((r) => r.stack.projectId));
      await Promise.all([...projects].map((p) => this.nudge(p)));
    } catch (error) {
      this.logger.error(
        'resuming stack runs failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * `POST /board/stacks/:number/run`: queues every To Do card of the stack
   * not queued yet, clears a pause, and starts what is ready. Pressing it
   * again on a paused or stopped run resumes from the cards left. Refused
   * with 409 `stack_design_not_approved` while the stack design is needed
   * and not approved.
   */
  async start(
    projectId: string,
    number: number,
    actor: BoardActor,
  ): Promise<BoardStackDetail> {
    const stack = await this.prisma.boardStack.findUnique({
      where: { projectId_number: { projectId, number } },
      select: {
        id: true,
        number: true,
        title: true,
        design: { select: { needed: true, status: true } },
        stages: {
          select: {
            cards: { select: { id: true, number: true, column: true } },
          },
        },
      },
    });
    if (!stack) throw boardError(404, BOARD_ERROR.notFound, 'Stack not found');
    if (isStackGated(stack.design)) {
      throw boardError(
        409,
        BOARD_ERROR.stackDesignNotApproved,
        `${stackLabel(stack.number)} "${stack.title}": the stack design is not approved yet`,
      );
    }
    const todo = stack.stages
      .flatMap((s) => s.cards)
      .filter((c) => c.column === 'todo')
      .sort((a, b) => a.number - b.number);
    const now = new Date();
    const added = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM board_stacks WHERE id = ${stack.id} FOR UPDATE`;
      const run = await tx.boardStackRun.upsert({
        where: { stackId: stack.id },
        create: {
          stackId: stack.id,
          state: 'running',
          startedById: actor.userId,
          startedByRole: actor.role,
          startedAt: now,
        },
        update: {
          state: 'running',
          startedById: actor.userId,
          startedByRole: actor.role,
          startedAt: now,
          pausedCode: null,
          pausedMessage: null,
          pausedCardId: null,
          pausedAt: null,
        },
      });
      // A card the run started earlier whose round is over is history now.
      const entries = await tx.boardStackRunCard.findMany({
        where: { runId: run.id },
        select: {
          id: true,
          cardId: true,
          status: true,
          roundId: true,
        },
      });
      const started = entries.filter((e) => e.status === 'started');
      const live = new Set(
        (
          await tx.boardCardRound.findMany({
            where: {
              id: { in: started.flatMap((e) => e.roundId ?? []) },
              phase: { in: ACTIVE_PHASES },
            },
            select: { id: true },
          })
        ).map((r) => r.id),
      );
      const over = started.filter(
        (e) => e.roundId === null || !live.has(e.roundId),
      );
      if (over.length > 0) {
        await tx.boardStackRunCard.deleteMany({
          where: { id: { in: over.map((e) => e.id) } },
        });
      }
      const kept = new Set(
        entries.filter((e) => !over.includes(e)).map((e) => e.cardId),
      );
      const add = todo.filter((c) => !kept.has(c.id));
      if (add.length > 0) {
        await tx.boardStackRunCard.createMany({
          data: add.map((c) => ({ runId: run.id, cardId: c.id })),
          skipDuplicates: true,
        });
      }
      return add;
    });
    await this.audit.record({
      ...actor.ctx,
      action: 'stack.run_started',
      target: { type: 'board_stack', id: stack.id },
      projectId,
      after: { number: stack.number, cards: added.map((c) => c.number) },
      result: 'ok',
    });
    this.work.publishStack(projectId, stack.id);
    await this.nudge(projectId);
    return this.stacks.detail(projectId, number);
  }

  /**
   * `POST /board/stacks/:number/stop`: removes the cards still queued; the
   * cards the run already started keep running. Run stack resumes later.
   */
  async stop(
    projectId: string,
    number: number,
    actor: BoardActor,
  ): Promise<BoardStackDetail> {
    const stack = await this.prisma.boardStack.findUnique({
      where: { projectId_number: { projectId, number } },
      select: { id: true, number: true, run: { select: { id: true } } },
    });
    if (!stack) throw boardError(404, BOARD_ERROR.notFound, 'Stack not found');
    const run = stack.run;
    if (run) {
      const removed = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM board_stack_runs WHERE id = ${run.id} FOR UPDATE`;
        const queued = await tx.boardStackRunCard.findMany({
          where: { runId: run.id, status: { in: ['queued', 'waiting'] } },
          select: { id: true, card: { select: { number: true } } },
        });
        await tx.boardStackRunCard.deleteMany({
          where: { id: { in: queued.map((q) => q.id) } },
        });
        await tx.boardStackRun.update({
          where: { id: run.id },
          data: {
            state: 'stopped',
            pausedCode: null,
            pausedMessage: null,
            pausedCardId: null,
            pausedAt: null,
          },
        });
        return queued.map((q) => q.card.number).sort((a, b) => a - b);
      });
      await this.audit.record({
        ...actor.ctx,
        action: 'stack.run_stopped',
        target: { type: 'board_stack', id: stack.id },
        projectId,
        after: { number: stack.number, removed },
        result: 'ok',
      });
      this.work.publishStack(projectId, stack.id);
    }
    return this.stacks.detail(projectId, number);
  }

  /**
   * Evaluates the project's running stack runs — at once, or once more after
   * the evaluation in flight. Resolves when the project is evaluated.
   */
  nudge(projectId: string): Promise<void> {
    const ticking = this.ticking.get(projectId);
    if (ticking) {
      this.again.add(projectId);
      return ticking;
    }
    const work = (async () => {
      do {
        this.again.delete(projectId);
        await this.tick(projectId);
      } while (this.again.has(projectId));
    })()
      .catch((error: unknown) => {
        this.logger.error(
          `the stack runs of project ${projectId} were not evaluated`,
          error instanceof Error ? error.stack : String(error),
        );
      })
      .finally(() => {
        this.ticking.delete(projectId);
        if (this.again.has(projectId)) void this.nudge(projectId);
      });
    this.ticking.set(projectId, work);
    this.work.background(work);
    return work;
  }

  /** One evaluation of the project's running stack runs. */
  private async tick(projectId: string): Promise<void> {
    const runs = await this.prisma.boardStackRun.findMany({
      where: { state: 'running', stack: { projectId } },
      include: RUN_INCLUDE,
      orderBy: { stack: { number: 'asc' } },
    });
    if (runs.length === 0) return;
    const changed = new Set<string>();
    const paused = new Set<string>();

    // A round the run started that failed pauses it.
    const startedRounds = runs.flatMap((run) =>
      run.cards.flatMap((e) =>
        e.status === 'started' && e.roundId ? [e.roundId] : [],
      ),
    );
    const rounds = new Map(
      (
        await this.prisma.boardCardRound.findMany({
          where: { id: { in: startedRounds } },
          select: { id: true, phase: true, error: true },
        })
      ).map((r) => [r.id, r]),
    );
    for (const run of runs) {
      for (const entry of run.cards) {
        const round = entry.roundId ? rounds.get(entry.roundId) : undefined;
        if (entry.status !== 'started' || !round) continue;
        if (!FAILED_PHASES.has(round.phase)) continue;
        await this.pause(projectId, run, entry.card, {
          code: 'round_failed',
          message: `The round of ${cardLabel(entry.card.number)} ${
            round.phase === 'failed' ? 'failed' : 'ended before it finished'
          }${round.error ? `: ${round.error}` : ''}`,
        });
        paused.add(run.id);
        break;
      }
    }

    // A queued card a person started or moved on is the run's no more to start.
    for (const run of runs) {
      for (const entry of run.cards) {
        if (entry.status === 'started' || entry.card.column === 'todo') {
          continue;
        }
        const latest = entry.card.rounds[0];
        if (latest && ACTIVE_PHASES.some((p) => p === latest.phase)) {
          await this.prisma.boardStackRunCard.update({
            where: { id: entry.id },
            data: { status: 'started', roundId: latest.id },
          });
          entry.status = 'started';
          entry.roundId = latest.id;
        } else {
          await this.prisma.boardStackRunCard.delete({
            where: { id: entry.id },
          });
        }
        changed.add(run.stack.id);
      }
    }

    // Start what is ready, in stack, stage then number order, while there is room.
    const candidates = runs
      .flatMap((run) =>
        run.cards
          .filter((e) => e.status !== 'started' && e.card.column === 'todo')
          .map((entry) => ({ run, entry })),
      )
      .sort(
        (a, b) =>
          a.run.stack.number - b.run.stack.number ||
          (a.entry.card.stage?.position ?? 0) -
            (b.entry.card.stage?.position ?? 0) ||
          a.entry.card.number - b.entry.card.number,
      );
    // Without its runner nothing starts, and nothing pauses: the run waits.
    const { runnerId } = await this.work.project(projectId);
    let held = !this.commands.isConnected(runnerId);
    for (const { run, entry } of candidates) {
      if (paused.has(run.id)) continue;
      const ready = await this.isReady(entry.card.id);
      if (!ready) {
        if (await this.setStatus(entry, 'waiting')) changed.add(run.stack.id);
        continue;
      }
      if (await this.setStatus(entry, 'queued')) changed.add(run.stack.id);
      if (held || !(await this.hasRoom(projectId))) {
        held = true;
        continue;
      }
      try {
        await this.rounds.run(projectId, entry.card.number, {}, actorOf(run));
      } catch (error) {
        const { code, message } = autoRunFailureOf(error);
        if (code === BOARD_ERROR.maxRunning) {
          held = true;
          continue;
        }
        if (WAITS_FOR_DEPENDENCY.has(code)) {
          if (await this.setStatus(entry, 'waiting')) {
            changed.add(run.stack.id);
          }
          continue;
        }
        this.logger.warn(
          `${stackLabel(run.stack.number)}: ${cardLabel(entry.card.number)} did not start: ${message}`,
        );
        await this.pause(projectId, run, entry.card, { code, message });
        paused.add(run.id);
        continue;
      }
      const round = await this.prisma.boardCardRound.findFirst({
        where: { cardId: entry.card.id },
        orderBy: { round: 'desc' },
        select: { id: true },
      });
      await this.prisma.boardStackRunCard.update({
        where: { id: entry.id },
        data: { status: 'started', roundId: round?.id ?? null },
      });
      entry.status = 'started';
      entry.roundId = round?.id ?? null;
      changed.add(run.stack.id);
    }

    // A run with nothing left to start and nothing it started still running is done.
    for (const run of runs) {
      if (paused.has(run.id)) continue;
      if (run.cards.some((e) => e.status !== 'started')) continue;
      const running = await this.prisma.boardCardRound.count({
        where: {
          id: { in: run.cards.flatMap((e) => e.roundId ?? []) },
          phase: { in: ACTIVE_PHASES },
        },
      });
      if (running > 0) continue;
      const { count } = await this.prisma.boardStackRun.updateMany({
        where: { id: run.id, state: 'running' },
        data: { state: 'done' },
      });
      if (count > 0) changed.add(run.stack.id);
    }

    for (const stackId of changed) this.work.publishStack(projectId, stackId);
  }

  /**
   * `assertRunnable` under the stacked-branch rules lets the card start: one
   * dependency that finished its round with an open PR (stacked on its
   * branch), or every dependency merged. A card with several dependencies
   * is not stacked on the one left unmerged: it waits for all of them.
   */
  private async isReady(cardId: string): Promise<boolean> {
    try {
      const stacked = await this.dependencies.assertRunnable(cardId);
      if (stacked === null) return true;
      const deps = await this.prisma.boardCardDependency.count({
        where: { cardId },
      });
      return deps === 1;
    } catch (error) {
      if (WAITS_FOR_DEPENDENCY.has(autoRunFailureOf(error).code)) return false;
      throw error;
    }
  }

  /** Fewer active rounds than `maxRunning` — what `assertRoom` checks. */
  private async hasRoom(projectId: string): Promise<boolean> {
    const [settings, active] = await Promise.all([
      this.prisma.boardSettings.findUnique({ where: { projectId } }),
      this.prisma.boardCardRound.count({
        where: { phase: { in: ACTIVE_PHASES }, card: { projectId } },
      }),
    ]);
    return active < toSettingsView(projectId, settings).maxRunning;
  }

  /** Stores a queued card's readiness; whether it changed. */
  private async setStatus(
    entry: RunEntry,
    status: 'queued' | 'waiting',
  ): Promise<boolean> {
    if (entry.status === status) return false;
    await this.prisma.boardStackRunCard.update({
      where: { id: entry.id },
      data: { status },
    });
    entry.status = status;
    return true;
  }

  /**
   * Pauses the run with the reason, shows a refused start on the card
   * (`autoRunFailure` with `stack`), and audits `stack.run_paused`.
   */
  private async pause(
    projectId: string,
    run: BoardStackRun & { stack: { id: string; number: number } },
    card: { id: string; number: number },
    reason: Pick<StackRunPause, 'code' | 'message'>,
  ): Promise<void> {
    const message = reason.message.slice(0, MESSAGE_MAX);
    const now = new Date();
    const { count } = await this.prisma.boardStackRun.updateMany({
      where: { id: run.id, state: 'running' },
      data: {
        state: 'paused',
        pausedCode: reason.code,
        pausedMessage: message,
        pausedCardId: card.id,
        pausedAt: now,
      },
    });
    if (count === 0) return;
    if (reason.code !== 'round_failed') {
      await this.prisma.boardCard.update({
        where: { id: card.id },
        data: {
          autoRunError: reason.code,
          autoRunMessage: message,
          autoRunFailedAt: now,
          autoRunAfter: null,
          autoRunStack: run.stack.number,
        },
      });
    }
    await this.audit.record({
      ...actorOf(run).ctx,
      action: 'stack.run_paused',
      target: { type: 'board_stack', id: run.stack.id },
      projectId,
      // `code` is a redacted audit key (auth codes): the reason goes as `error`.
      after: {
        number: run.stack.number,
        card: card.number,
        error: reason.code,
      },
      result: 'error',
      meta: { message },
    });
    this.work.publishStack(projectId, run.stack.id);
    this.work.publish(projectId, card.id);
  }
}
