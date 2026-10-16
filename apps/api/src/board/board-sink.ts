import {
  CARD_WAITING_EVENT,
  type CardWaitingEventData,
  isActiveRoundPhase,
} from '@agentdock/shared';
import {
  type CardRunPhaseChangedData,
  type CardRunPushedData,
  cardPushEventDataSchemas,
  cardRunEventDataSchemas,
  HOOK_PROMPT_SUBMITTED_EVENT,
  HOOK_SESSION_ENDED_EVENT,
  HOOK_STOPPED_EVENT,
  isCardPushEventType,
  isCardRunEventType,
  parseHookEvent,
  type RunnerEvent,
} from '@agentdock/shared/protocol';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  type RunnerEventSink,
  RunnerEventSinks,
} from '../runners/runner-event-sinks';
import { BoardTerminalService } from './board-terminal.service';
import {
  ACTIVE_PHASES,
  BOARD_SYSTEM_ACTOR,
  type BoardProject,
  BoardWork,
} from './board-work';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sink `board` (issue #242 D6, D14): applies `card_run.phase_changed` and the
 * `hook.*` events of card sessions to rounds and cards. A card is touched
 * only by the runner of its project. Every transition is a conditional
 * update on the round's phase, so a replayed batch changes nothing.
 *
 * Registered at bootstrap, after every sink registered in `onModuleInit`, so
 * it runs after the sessions sink: the session row of the first hook event
 * exists when the origin claim (an idempotent `updateMany`, repeated on every
 * hook event of the session) runs.
 */
@Injectable()
export class BoardSink implements RunnerEventSink, OnApplicationBootstrap {
  readonly name = 'board';
  private readonly logger = new Logger(BoardSink.name);

  constructor(
    private readonly sinks: RunnerEventSinks,
    private readonly prisma: PrismaService,
    private readonly work: BoardWork,
    private readonly terminal: BoardTerminalService,
  ) {}

  onApplicationBootstrap(): void {
    this.sinks.register(this);
  }

  async handle(runnerId: string, events: RunnerEvent[]): Promise<void> {
    for (const event of events) {
      if (isCardRunEventType(event.type)) {
        const parsed = cardRunEventDataSchemas[event.type].safeParse(
          event.data,
        );
        if (!parsed.success) {
          this.logger.warn(
            `runner ${runnerId}: malformed ${event.type} (seq ${event.seq}), skipped`,
          );
          continue;
        }
        await this.phaseChanged(runnerId, parsed.data);
        continue;
      }
      if (isCardPushEventType(event.type)) {
        const parsed = cardPushEventDataSchemas[event.type].safeParse(
          event.data,
        );
        if (!parsed.success) {
          this.logger.warn(
            `runner ${runnerId}: malformed ${event.type} (seq ${event.seq}), skipped`,
          );
          continue;
        }
        await this.pushed(runnerId, parsed.data);
        continue;
      }
      const hook = parseHookEvent(event);
      if (hook?.ok) {
        await this.hook(
          runnerId,
          event.seq,
          hook.event.type,
          hook.event.session,
        );
      }
    }
  }

  /** The round of `runId`, if its card is `cardId` of `projectId` on this runner. */
  private roundOf(
    runnerId: string,
    data: Pick<CardRunPhaseChangedData, 'runId' | 'cardId' | 'projectId'>,
  ) {
    return this.prisma.boardCardRound.findFirst({
      where: {
        runId: data.runId,
        cardId: data.cardId,
        card: { projectId: data.projectId, project: { runnerId } },
      },
      include: {
        card: {
          select: { number: true, column: true, branch: true, ciHeadSha: true },
        },
      },
    });
  }

  /**
   * #359 D1: the runner pushed the round's committed HEAD and, once one is
   * open, names the draft PR — the card shows it while In progress, lists
   * it (D8), and a new head starts its CI state over (D5). A push of a
   * branch the card has left (a follow-up started since) is stale.
   */
  private async pushed(
    runnerId: string,
    data: CardRunPushedData,
  ): Promise<void> {
    const round = await this.roundOf(runnerId, data);
    if (!round) {
      this.logger.warn(
        `runner ${runnerId}: push for unknown card round ${data.runId}, skipped`,
      );
      return;
    }
    if (round.card.branch !== data.branch) return;
    const newHead = round.card.ciHeadSha !== data.headSha;
    await this.prisma.boardCard.update({
      where: { id: round.cardId },
      data: {
        ...(data.prNumber !== undefined && data.prUrl !== undefined
          ? {
              prNumber: data.prNumber,
              prUrl: data.prUrl,
              prState: data.prState ?? 'open',
            }
          : {}),
        ...(newHead
          ? {
              ciHeadSha: data.headSha,
              ciState: 'none',
              ciChecks: Prisma.DbNull,
              ciCheckedAt: null,
            }
          : {}),
      },
    });
    if (data.prNumber !== undefined && data.prUrl !== undefined) {
      await this.work.recordPullRequest(round.cardId, {
        number: data.prNumber,
        url: data.prUrl,
        branch: data.branch,
        state: data.prState ?? 'open',
        round: round.round,
      });
    }
    this.work.publish(data.projectId, round.cardId);
  }

  private async phaseChanged(
    runnerId: string,
    data: CardRunPhaseChangedData,
  ): Promise<void> {
    const round = await this.roundOf(runnerId, data);
    if (!round) {
      this.logger.warn(
        `runner ${runnerId}: ${data.phase} for unknown card round ${data.runId}, skipped`,
      );
      return;
    }
    const at = new Date(data.at);
    switch (data.phase) {
      case 'starting':
      case 'running': {
        const from =
          data.phase === 'starting'
            ? (['queued'] as const)
            : (['queued', 'starting'] as const);
        await this.prisma.$transaction(async (tx) => {
          await tx.boardCardRound.updateMany({
            where: { id: round.id, phase: { in: [...from] } },
            data: { phase: data.phase },
          });
          if (data.tmuxSession) {
            await tx.boardCardRound.updateMany({
              where: { id: round.id, tmuxSession: null },
              data: { tmuxSession: data.tmuxSession },
            });
          }
          if (data.phase === 'running') {
            // #367 D3: a runner older than #367 sends no facts — it wires nothing.
            const wiring = data.wiring ?? 'none';
            await tx.boardCardRound.updateMany({
              where: { id: round.id, wiring: null },
              data: {
                wiring,
                wiringReason:
                  wiring === 'none'
                    ? (data.wiringReason ??
                      (data.wiring === undefined ? 'runner_outdated' : null))
                    : null,
              },
            });
          }
          if (data.worktree) {
            await tx.boardCard.update({
              where: { id: round.cardId },
              data: { worktree: data.worktree },
            });
          }
        });
        break;
      }
      case 'failed': {
        const ended = await this.prisma.$transaction(async (tx) => {
          const done = await this.work.endRound(tx, round.id, 'failed', at, {
            error: data.error ?? 'The worker could not start',
            ...(data.exitCode !== undefined ? { exitCode: data.exitCode } : {}),
          });
          if (done) {
            await this.work.closeRun(tx, round.runId, 'failed', data.error);
          }
          return done;
        });
        if (ended) this.work.publishRun(data.projectId, round.runId, 'failed');
        break;
      }
      case 'ended': {
        // D6 (2): the session ended before anything else finished the round.
        const ended = await this.prisma.$transaction(async (tx) => {
          await tx.boardCardRound.updateMany({
            where: { id: round.id, endedAt: null },
            data: {
              endedAt: at,
              ...(data.exitCode !== undefined
                ? { exitCode: data.exitCode }
                : {}),
            },
          });
          const done = await this.work.endRound(tx, round.id, 'finished', at, {
            finishedBy: 'session_end',
          });
          if (done) await this.work.closeRun(tx, round.runId, 'succeeded');
          return done;
        });
        if (ended) {
          this.work.publishRun(data.projectId, round.runId, 'succeeded');
          await this.toFinished(data.projectId, round.card.number);
        }
        break;
      }
    }
    this.work.publish(data.projectId, round.cardId);
  }

  /** The work moves the card to Finished, which collects (D8). */
  private async toFinished(projectId: string, number: number): Promise<void> {
    let project: BoardProject;
    try {
      project = await this.work.project(projectId);
      const card = await this.work.card(projectId, number);
      if (card.column !== 'in_progress') return;
      await this.work.move(
        project,
        card,
        { to: 'finished', index: 0, source: 'automatic' },
        BOARD_SYSTEM_ACTOR,
      );
    } catch (error) {
      // A refused or vanished card is not the batch's failure.
      this.logger.warn(
        `card ${projectId}#${number} not moved to Finished: ${(error as Error).message}`,
      );
    }
  }

  /**
   * D6: `hook.stopped` → `waiting` and `card.waiting`; `hook.prompt_submitted`
   * → `running`. D14: every hook event claims the session as `origin = run`.
   */
  private async hook(
    runnerId: string,
    seq: number,
    type: string,
    session: { runtime: string; id: string },
  ): Promise<void> {
    if (session.runtime !== 'claude' || !UUID.test(session.id)) return;
    // #282 D2: a tracked session's end moves its card to Finished. The
    // sessions sink, registered earlier, has written its `endedAt` by now.
    if (type === HOOK_SESSION_ENDED_EVENT) {
      await this.terminal.sessionEnded(runnerId, session.id);
    }
    const card = await this.prisma.boardCard.findFirst({
      where: { sessionId: session.id, project: { runnerId } },
      include: {
        rounds: { orderBy: { round: 'desc' }, take: 1 },
        project: { select: { runnerId: true, rootPath: true, repo: true } },
      },
    });
    if (!card) return;
    await this.prisma.agentSession.updateMany({
      where: {
        runnerId,
        runtime: 'claude',
        externalId: session.id,
        origin: { not: 'run' },
      },
      data: { origin: 'run' },
    });
    const round = card.rounds[0];
    if (!round || !isActiveRoundPhase(round.phase)) return;

    let changed = false;
    if (type === HOOK_STOPPED_EVENT) {
      changed = await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const { count } = await tx.boardCardRound.updateMany({
          where: {
            id: round.id,
            phase: { in: ['queued', 'starting', 'running'] },
          },
          data: { phase: 'waiting', waitingAt: now },
        });
        if (count === 0) return false;
        await this.work.runStatus(tx, round.runId, 'waiting_person');
        const data: CardWaitingEventData = {
          cardId: card.id,
          number: card.number,
          title: card.title,
          round: round.round,
        };
        await this.work.serverEvent(
          tx,
          card.project,
          CARD_WAITING_EVENT,
          `${round.id}:${runnerId}:${seq}`,
          { ...data },
        );
        return true;
      });
    } else if (type === HOOK_PROMPT_SUBMITTED_EVENT) {
      changed = await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.boardCardRound.updateMany({
          where: {
            id: round.id,
            phase: { in: ACTIVE_PHASES.filter((p) => p !== 'running') },
          },
          data: { phase: 'running' },
        });
        if (count === 0) return false;
        await this.work.runStatus(tx, round.runId, 'running');
        return true;
      });
    }
    if (changed) this.work.publish(card.projectId, card.id);
  }
}
