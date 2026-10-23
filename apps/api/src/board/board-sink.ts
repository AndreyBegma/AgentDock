import {
  CARD_BACKGROUND_COMMAND_MAX,
  CARD_ROUND_AT_ONCE_MS,
  CARD_WAITING_EVENT,
  type CardWaitingEventData,
  type CardWaitingReason,
  isActiveRoundPhase,
} from '@nautelle/shared';
import {
  type CardRunDialogData,
  type CardRunFinishRefusedData,
  type CardRunPendingQuestionData,
  type CardRunPhaseChangedData,
  type CardRunPushedData,
  type CardRunQuestionData,
  type CardRunQuotaData,
  cardDialogEventDataSchemas,
  cardFinishRefusedEventDataSchemas,
  cardPendingQuestionEventDataSchemas,
  cardPushEventDataSchemas,
  cardQuestionEventDataSchemas,
  cardQuotaEventDataSchemas,
  cardRunEventDataSchemas,
  HOOK_PROMPT_SUBMITTED_EVENT,
  HOOK_SESSION_ENDED_EVENT,
  HOOK_STOPPED_EVENT,
  HOOK_TOOL_FINISHED_EVENT,
  type HookEvent,
  isCardDialogEventType,
  isCardFinishRefusedEventType,
  isCardPendingQuestionEventType,
  isCardPushEventType,
  isCardQuestionEventType,
  isCardQuotaEventType,
  isCardRunEventType,
  type PaneDialog,
  parseHookEvent,
  type RunnerEvent,
} from '@nautelle/shared/protocol';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { type BoardCard, type BoardCardRound, Prisma } from '@prisma/client';
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

/** #390: a round that left `background` keeps nothing of it. */
const NO_BACKGROUND = {
  backgroundAt: null,
  backgroundTasks: null,
  backgroundCommand: null,
  backgroundStalledAt: null,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sink `board` (issue #242 D6, D14): applies `card_run.phase_changed`,
 * `card_run.question` (#473) and the `hook.*` events of card sessions to
 * rounds and cards. A card is touched
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
      if (isCardQuestionEventType(event.type)) {
        const parsed = cardQuestionEventDataSchemas[event.type].safeParse(
          event.data,
        );
        if (!parsed.success) {
          this.logger.warn(
            `runner ${runnerId}: malformed ${event.type} (seq ${event.seq}), skipped`,
          );
          continue;
        }
        await this.question(runnerId, event.seq, parsed.data);
        continue;
      }
      if (isCardDialogEventType(event.type)) {
        const parsed = cardDialogEventDataSchemas[event.type].safeParse(
          event.data,
        );
        if (!parsed.success) {
          this.logger.warn(
            `runner ${runnerId}: malformed ${event.type} (seq ${event.seq}), skipped`,
          );
          continue;
        }
        await this.dialog(runnerId, event.seq, parsed.data);
        continue;
      }
      if (isCardQuotaEventType(event.type)) {
        const parsed = cardQuotaEventDataSchemas[event.type].safeParse(
          event.data,
        );
        if (!parsed.success) {
          this.logger.warn(
            `runner ${runnerId}: malformed ${event.type} (seq ${event.seq}), skipped`,
          );
          continue;
        }
        await this.quota(runnerId, parsed.data);
        continue;
      }
      if (isCardPendingQuestionEventType(event.type)) {
        const parsed = cardPendingQuestionEventDataSchemas[
          event.type
        ].safeParse(event.data);
        if (!parsed.success) {
          this.logger.warn(
            `runner ${runnerId}: malformed ${event.type} (seq ${event.seq}), skipped`,
          );
          continue;
        }
        await this.pendingQuestion(runnerId, parsed.data);
        continue;
      }
      if (isCardFinishRefusedEventType(event.type)) {
        const parsed = cardFinishRefusedEventDataSchemas[event.type].safeParse(
          event.data,
        );
        if (!parsed.success) {
          this.logger.warn(
            `runner ${runnerId}: malformed ${event.type} (seq ${event.seq}), skipped`,
          );
          continue;
        }
        await this.finishRefused(runnerId, parsed.data);
        continue;
      }
      const hook = parseHookEvent(event);
      if (hook?.ok) await this.hook(runnerId, event.seq, hook.event);
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
        // C-148: the paths of the push that only a person may merge.
        ...(data.protectedPaths !== undefined
          ? { protectedPaths: data.protectedPaths }
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

  /**
   * #473: the worker asks the person a question in its session — the round
   * waits for the person, as after a stop, and `card.waiting` tells them.
   * Only an active round of the card's current run moves; the answer's
   * `hook.tool_finished` moves it back to `running`.
   */
  private async question(
    runnerId: string,
    seq: number,
    data: CardRunQuestionData,
  ): Promise<void> {
    await this.toWaitingOnScreen(runnerId, seq, data, 'question');
  }

  /**
   * #624: a Claude Code dialog has blocked the round's session for
   * `CARD_DIALOG_WAIT_MS` — the round waits for the person, the card names
   * the dialog, and `card.waiting` tells them. The answer's next hook event
   * moves it back to `running`.
   */
  private async dialog(
    runnerId: string,
    seq: number,
    data: CardRunDialogData,
  ): Promise<void> {
    await this.toWaitingOnScreen(runnerId, seq, data, 'dialog', data.dialog);
  }

  /**
   * What the runner saw on an active round's screen — a question (#473) or
   * a blocking dialog (#624) — moves it to `waiting`; only for the card's
   * current run.
   */
  private async toWaitingOnScreen(
    runnerId: string,
    seq: number,
    data: CardRunQuestionData,
    reason: 'question' | 'dialog',
    dialog?: PaneDialog,
  ): Promise<void> {
    const card = await this.prisma.boardCard.findFirst({
      where: {
        id: data.cardId,
        projectId: data.projectId,
        project: { runnerId },
      },
      include: {
        rounds: { orderBy: { round: 'desc' }, take: 1 },
        project: { select: { runnerId: true, rootPath: true, repo: true } },
      },
    });
    const round = card?.rounds[0];
    if (!card || !round || round.runId !== data.runId) {
      this.logger.warn(
        `runner ${runnerId}: ${reason} for unknown card round ${data.runId}, skipped`,
      );
      return;
    }
    if (!isActiveRoundPhase(round.phase)) return;
    if (await this.toWaiting(runnerId, seq, card, round, reason, dialog)) {
      this.work.publish(card.projectId, card.id);
    }
  }

  /**
   * #741: the round's pane shows a usage-limit banner — the card says it
   * waits for the limit until the banner's reset time — or the runner has
   * resumed it, which clears that. The phase does not move: the session is
   * still the round's. An active round of the card's current run only.
   */
  private async quota(runnerId: string, data: CardRunQuotaData): Promise<void> {
    const round = await this.roundOf(runnerId, data);
    if (!round) {
      this.logger.warn(
        `runner ${runnerId}: usage limit for unknown card round ${data.runId}, skipped`,
      );
      return;
    }
    const { count } = await this.prisma.boardCardRound.updateMany({
      where: { id: round.id, phase: { in: [...ACTIVE_PHASES] } },
      data: data.resumed
        ? { quotaLimit: null, quotaResetsAt: null }
        : {
            quotaLimit: data.limit,
            quotaResetsAt: data.resetsAt ? new Date(data.resetsAt) : null,
          },
    });
    if (count > 0) this.work.publish(data.projectId, round.cardId);
  }

  /**
   * #489 M4: what the round's question selector shows now, or null once it
   * is gone. Kept on an active round of the card's current run only; the
   * Board offers its options and Telegram its buttons.
   */
  private async pendingQuestion(
    runnerId: string,
    data: CardRunPendingQuestionData,
  ): Promise<void> {
    const round = await this.roundOf(runnerId, data);
    if (!round) {
      this.logger.warn(
        `runner ${runnerId}: question screen for unknown card round ${data.runId}, skipped`,
      );
      return;
    }
    const { count } = await this.prisma.boardCardRound.updateMany({
      where: {
        id: round.id,
        phase: { in: [...ACTIVE_PHASES] },
      },
      data: { pendingQuestion: data.question ?? Prisma.DbNull },
    });
    if (count > 0) this.work.publish(data.projectId, round.cardId);
  }

  /**
   * #482: the API refused the worker's `finish_card` — the round needs
   * attention, with the reason, instead of waiting in silence. Only an active
   * round of the card's current run is marked; a later refusal replaces the
   * reason, and a finish that is taken leaves the active phases behind it.
   */
  private async finishRefused(
    runnerId: string,
    data: CardRunFinishRefusedData,
  ): Promise<void> {
    const card = await this.prisma.boardCard.findFirst({
      where: {
        id: data.cardId,
        projectId: data.projectId,
        project: { runnerId },
      },
      include: { rounds: { orderBy: { round: 'desc' }, take: 1 } },
    });
    const round = card?.rounds[0];
    if (!card || !round || round.runId !== data.runId) {
      this.logger.warn(
        `runner ${runnerId}: refused finish for unknown card round ${data.runId}, skipped`,
      );
      return;
    }
    const { count } = await this.prisma.boardCardRound.updateMany({
      where: { id: round.id, phase: { in: ACTIVE_PHASES } },
      data: {
        finishRefusedCode: data.code,
        finishRefusedAt: new Date(data.at),
      },
    });
    if (count > 0) this.work.publish(card.projectId, card.id);
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
        // #542: a feedback round whose session died at start did no work.
        if (
          round.trigger === 'feedback' &&
          at.getTime() - round.startedAt.getTime() < CARD_ROUND_AT_ONCE_MS
        ) {
          await this.diedAtStart(data, round, at);
          break;
        }
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

  /**
   * #542: the session of a `feedback` round ended within
   * `CARD_ROUND_AT_ONCE_MS` of its start — the round `failed`, not
   * finished. The card stays where it is; auto-merge never ships the head
   * a failed round leaves.
   */
  private async diedAtStart(
    data: CardRunPhaseChangedData,
    round: { id: string; runId: string; startedAt: Date },
    at: Date,
  ): Promise<void> {
    const seconds = Math.max(
      0,
      Math.round((at.getTime() - round.startedAt.getTime()) / 1000),
    );
    const error = `The worker's session ended ${seconds} s after the round started, before it did any work`;
    const ended = await this.prisma.$transaction(async (tx) => {
      const done = await this.work.endRound(tx, round.id, 'failed', at, {
        error,
        endedAt: at,
        ...(data.exitCode !== undefined ? { exitCode: data.exitCode } : {}),
      });
      if (done) await this.work.closeRun(tx, round.runId, 'failed', error);
      return done;
    });
    if (ended) this.work.publishRun(data.projectId, round.runId, 'failed');
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
   * D6: `hook.stopped` → `waiting` and `card.waiting`; #390 (ADR-0038): a stop
   * with the session's background tasks still running → `background`, and
   * any later activity (`hook.prompt_submitted`, `hook.tool_finished` — a
   * task notification wakes the worker without a prompt) → `running`. D14:
   * every hook event claims the session as `origin = run`.
   */
  private async hook(
    runnerId: string,
    seq: number,
    event: HookEvent,
  ): Promise<void> {
    const { type, session } = event;
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
        project: {
          select: {
            runnerId: true,
            rootPath: true,
            repo: true,
            shipSessionContent: true,
          },
        },
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
    if (event.type === HOOK_STOPPED_EVENT) {
      const tasks = event.data.backgroundTasks ?? 0;
      changed =
        tasks > 0
          ? await this.toBackground(round, tasks, {
              command: card.project.shipSessionContent
                ? (event.data.background?.text ?? null)
                : null,
            })
          : await this.toWaiting(runnerId, seq, card, round, 'stopped');
    } else if (
      type === HOOK_PROMPT_SUBMITTED_EVENT ||
      type === HOOK_TOOL_FINISHED_EVENT
    ) {
      changed = await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.boardCardRound.updateMany({
          where: {
            id: round.id,
            phase: { in: ACTIVE_PHASES.filter((p) => p !== 'running') },
          },
          data: { phase: 'running', blockingDialog: null, ...NO_BACKGROUND },
        });
        if (count === 0) return false;
        await this.work.runStatus(tx, round.runId, 'running');
        return true;
      });
    }
    if (changed) this.work.publish(card.projectId, card.id);
  }

  /**
   * D6: the turn ended, (#473) the worker asks a question, or (#624) a
   * dialog blocks its session — it waits for the person. Only a round not
   * yet waiting moves, so `card.waiting` is recorded once per stop, question
   * or dialog.
   */
  private toWaiting(
    runnerId: string,
    seq: number,
    card: Pick<BoardCard, 'id' | 'number' | 'title'> & {
      project: Pick<BoardProject, 'runnerId' | 'rootPath' | 'repo'>;
    },
    round: Pick<BoardCardRound, 'id' | 'runId' | 'round'>,
    reason: CardWaitingReason,
    dialog?: PaneDialog,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.boardCardRound.updateMany({
        where: {
          id: round.id,
          phase: { in: ['queued', 'starting', 'running', 'background'] },
        },
        data: {
          phase: 'waiting',
          waitingAt: new Date(),
          blockingDialog: dialog ?? null,
          ...NO_BACKGROUND,
        },
      });
      if (count === 0) return false;
      await this.work.runStatus(tx, round.runId, 'waiting_person');
      const data: CardWaitingEventData = {
        cardId: card.id,
        number: card.number,
        title: card.title,
        round: round.round,
        reason,
        ...(dialog ? { dialog } : {}),
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
  }

  /**
   * #390: the turn ended with background tasks running — the worker waits on
   * them, not on the person. A stall starts on entry; a stop while already
   * in `background` only refreshes what runs.
   */
  private toBackground(
    round: Pick<
      BoardCardRound,
      'id' | 'runId' | 'backgroundTasks' | 'backgroundCommand'
    >,
    tasks: number,
    { command }: { command: string | null },
  ): Promise<boolean> {
    const backgroundCommand =
      command === null ? null : command.slice(0, CARD_BACKGROUND_COMMAND_MAX);
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.boardCardRound.updateMany({
        where: {
          id: round.id,
          phase: { in: ['queued', 'starting', 'running', 'waiting'] },
        },
        data: {
          phase: 'background',
          backgroundAt: new Date(),
          backgroundTasks: tasks,
          backgroundCommand,
          backgroundStalledAt: null,
        },
      });
      if (count > 0) {
        await this.work.runStatus(tx, round.runId, 'running');
        return true;
      }
      if (
        round.backgroundTasks === tasks &&
        round.backgroundCommand === backgroundCommand
      ) {
        return false;
      }
      const refreshed = await tx.boardCardRound.updateMany({
        where: { id: round.id, phase: 'background' },
        data: { backgroundTasks: tasks, backgroundCommand },
      });
      return refreshed.count > 0;
    });
  }
}
