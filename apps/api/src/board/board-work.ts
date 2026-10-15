import { randomInt } from 'node:crypto';
import {
  ACTIVE_CARD_ROUND_PHASES,
  BOARD_CHANGED_EVENT,
  BOARD_ERROR,
  type BoardChangedData,
  type BoardColumn,
  type BoardMoveDecision,
  type BoardMoveEffect,
  type BoardMoveRefusal,
  type BoardMoveSource,
  boardMoveRule,
  CARD_COLLECT_AUTO_ATTEMPTS_MAX,
  CARD_COLLECT_ERROR_MAX,
  CARD_COLLECT_RETRY_DELAY_MS,
  CARD_FINISHED_EVENT,
  type CardAutoRunFailure,
  type CardCollectOutcome,
  type CardFinishedBy,
  type CardFinishedEventData,
  cardLabel,
  cardPullRequestBody,
  positionForIndex,
  type Role,
  RUN_UPDATED_LIVE_EVENT,
  type RunLiveChange,
  rebalancedPositions,
} from '@agentdock/shared';
import { API_EVENT_SOURCE } from '@agentdock/shared/protocol';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type BoardCard, Prisma, type RunStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { type AuditContext, SYSTEM_ACTOR } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { LiveService } from '../live/live.service';
import type { SpecTargetProject } from '../planner/spec-target';
import { projectNotFound } from '../projects';
import { RunnerConnectHooks } from '../runners/runner-connect-hooks';
import { recordServerEvent } from '../server-events/server-events';
import { BoardCommands, boardOutput } from './board-commands';
import { BoardFailure, boardError, cardNotFound } from './board-error';
import type { CardWithRounds } from './board-mapper';
import { CollectRetryTimer } from './collect-retry-timer';

type Tx = Prisma.TransactionClient;

/** Who acts on the board: a person, or the board itself (`userId: null`). */
export interface BoardActor {
  userId: string | null;
  /** Sent with runner commands; every `card.*` needs operator (D11). */
  role: Role;
  ctx: AuditContext;
}

/** The board's own moves: Run → In progress, done → Finished. */
export const BOARD_SYSTEM_ACTOR: BoardActor = {
  userId: null,
  role: 'operator',
  ctx: { actor: SYSTEM_ACTOR },
};

/** What the board needs of a project. */
export interface BoardProject {
  id: string;
  runnerId: string;
  rootPath: string;
  repo: string;
  base: string;
  defaultProfileId: string | null;
  codeSentinelConfig: Prisma.JsonValue;
  /** #379: where a card's spec goes (`resolveSpecTarget`). */
  docsSource: SpecTargetProject['docsSource'];
}

export const ACTIVE_PHASES = [...ACTIVE_CARD_ROUND_PHASES];

const SHORT_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** D5: the 8-character id of a card's worktree, tmux session and runner record. */
const newShortId = (): string =>
  Array.from(
    { length: 8 },
    () => SHORT_ID_ALPHABET[randomInt(SHORT_ID_ALPHABET.length)],
  ).join('');

/** #282 D3: a `terminal` card whose session reported no cwd or branch. */
export const TERMINAL_NO_BRANCH =
  'The tracked session reported no working directory or branch: nothing was pushed and no pull request was opened';

/** #282 D3: a `terminal` card whose session works on the project's base. */
export const terminalOnBase = (base: string): string =>
  `The session works on the base branch ${base}: nothing was pushed and no pull request was opened`;

/**
 * #329: what started a collect — the round's move to Finished, an automatic
 * retry (D4), or a person's Create pull request (D5).
 */
export type CollectTrigger = 'move' | 'retry' | 'manual';

/** #329 D4: a card an automatic retry may still claim. */
const RETRYABLE = {
  column: 'finished',
  collectState: 'failed',
  collectAttempts: { lt: CARD_COLLECT_AUTO_ATTEMPTS_MAX },
} satisfies Prisma.BoardCardWhereInput;

/** #329 D2: the runner pushed commits yet reported no open PR. */
export const PUSHED_WITHOUT_PR =
  'The branch has commits ahead of the base, but the runner reported no open pull request';

const failedCollect = (error: string): CardCollectOutcome => ({
  state: 'failed',
  error: error.slice(0, CARD_COLLECT_ERROR_MAX),
  ahead: null,
  prNumber: null,
  prUrl: null,
});

type CardForCollect = Prisma.BoardCardGetPayload<{
  include: {
    rounds: true;
    trackedSession: { select: { cwd: true; gitBranch: true } };
  };
}>;

/** The `runs.status` a round's end gives its run. */
const RUN_STATUS_OF: Record<'finished' | 'failed' | 'cancelled', RunStatus> = {
  finished: 'succeeded',
  failed: 'failed',
  cancelled: 'abandoned',
};

export interface MoveRequest {
  to: BoardColumn;
  /** The drop index in `to`; ignored for an automatic move within a column. */
  index: number;
  source: BoardMoveSource;
  stopWorker?: boolean;
  /** Who finished the round on a `finish` effect; `person` by default. */
  finishedBy?: CardFinishedBy;
  /** The worker's `finish_card` summary. */
  summary?: string;
  /** `accept_suggestion` (#244 D9): the fields Edit & accept changed, for the audit record. */
  edits?: Record<string, unknown>;
}

/** The message of each `move_refused` reason. */
const MOVE_REFUSED: Record<
  Exclude<BoardMoveRefusal, 'card_running' | 'invalid_move'>,
  string
> = {
  automatic_to_completed: 'Only a person completes a card',
  card_completed: 'A completed card is moved only by a person',
  plan_task_derived: 'A completed card is moved only by a person',
  // #282 D4: the column follows the slot.
  fleet_slot:
    'A fleet card follows its slot: the one move it takes is Finished → Completed',
};

const refusalOf = (
  decision: Extract<BoardMoveDecision, { allowed: false }>,
): BoardFailure =>
  decision.error === 'card_running'
    ? boardError(
        409,
        BOARD_ERROR.cardRunning,
        'The worker is running: stop it first, or move the card to Finished',
      )
    : decision.error === 'invalid_move'
      ? boardError(
          409,
          BOARD_ERROR.invalidMove,
          'A suggestion leaves the Inbox only for To Do, and nothing else enters it',
        )
      : boardError(409, BOARD_ERROR.moveRefused, MOVE_REFUSED[decision.error], {
          reason: decision.error,
        });

/**
 * The board's shared moves and side effects (issue #242 D7, D8, D10): column
 * moves under `boardMoveRule`, round endings, `card.collect` and `card.close`
 * in the background, the `card.finished` server event, live updates. The
 * controller's services, the round service and the sink all move cards
 * through here, so a rule is enforced in one place.
 */
@Injectable()
export class BoardWork implements OnModuleInit {
  private readonly logger = new Logger(BoardWork.name);
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: BoardCommands,
    private readonly live: LiveService,
    private readonly audit: AuditService,
    private readonly retryTimer: CollectRetryTimer,
    private readonly connectHooks: RunnerConnectHooks,
  ) {}

  /** #329 D4: a failed collect is retried when its runner connects. */
  onModuleInit(): void {
    this.connectHooks.register({
      name: 'board',
      connected: (runnerId) => this.retryCollectsOf(runnerId),
    });
  }

  async project(projectId: string): Promise<BoardProject> {
    const row = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        runnerId: true,
        rootPath: true,
        repo: true,
        baseBranch: true,
        baseOverride: true,
        defaultProfileId: true,
        codeSentinelConfig: true,
        docsSource: {
          select: { kind: true, localPath: true, repo: true, specDir: true },
        },
      },
    });
    if (!row) throw projectNotFound();
    return {
      id: row.id,
      runnerId: row.runnerId,
      rootPath: row.rootPath,
      repo: row.repo,
      base: row.baseOverride ?? row.baseBranch,
      defaultProfileId: row.defaultProfileId,
      codeSentinelConfig: row.codeSentinelConfig,
      docsSource: row.docsSource,
    };
  }

  /** A card of the project by its number, with its rounds newest first. */
  async card(
    projectId: string,
    number: number,
    db: PrismaService | Tx = this.prisma,
  ): Promise<CardWithRounds> {
    const card = await db.boardCard.findUnique({
      where: { projectId_number: { projectId, number } },
      include: { rounds: { orderBy: { round: 'desc' } } },
    });
    if (!card) throw cardNotFound();
    return card;
  }

  /**
   * D1: the project's next card number and a fresh short id. Takes the
   * project's number lock for the rest of the transaction, so concurrent
   * creates never collide.
   */
  async nextCard(
    tx: Tx,
    projectId: string,
  ): Promise<{ number: number; shortId: string }> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`board-number:${projectId}`}))`;
    const last = await tx.boardCard.aggregate({
      where: { projectId },
      _max: { number: true },
    });
    return { number: (last._max.number ?? 0) + 1, shortId: newShortId() };
  }

  /** Locks the card's row for the transaction and reads it again. */
  async lock(tx: Tx, cardId: string): Promise<CardWithRounds> {
    await tx.$queryRaw`SELECT 1 FROM board_cards WHERE id = ${cardId} FOR UPDATE`;
    const card = await tx.boardCard.findUnique({
      where: { id: cardId },
      include: { rounds: { orderBy: { round: 'desc' } } },
    });
    if (!card) throw cardNotFound();
    return card;
  }

  /**
   * D7: moves the card under `boardMoveRule` and carries out the effects.
   * `stop` reaches the runner before anything is written, so a runner that
   * cannot stop the worker leaves the card where it was.
   */
  async move(
    project: BoardProject,
    card: CardWithRounds,
    request: MoveRequest,
    actor: BoardActor,
  ): Promise<void> {
    const before = this.decide(card, request);
    if (!before.allowed) throw refusalOf(before);
    let stopped: boolean | null = null;
    if (before.effects.includes('stop')) {
      stopped = await this.stopOnRunner(project, card, actor);
    }

    const now = new Date();
    const outcome = await this.prisma.$transaction(async (tx) => {
      const fresh = await this.lock(tx, card.id);
      const decision = this.decide(fresh, request);
      if (!decision.allowed) throw refusalOf(decision);
      const round = fresh.rounds[0] ?? null;
      const ended: { runId: string; status: RunStatus }[] = [];
      if (round && decision.effects.includes('stop')) {
        if (await this.endRound(tx, round.id, 'cancelled', now)) {
          ended.push({ runId: round.runId, status: 'abandoned' });
        }
      }
      if (round && decision.effects.includes('finish')) {
        if (
          await this.endRound(tx, round.id, 'finished', now, {
            finishedBy: request.finishedBy ?? 'person',
            summary: request.summary,
          })
        ) {
          ended.push({ runId: round.runId, status: 'succeeded' });
        }
      }
      for (const run of ended) await this.closeRun(tx, run.runId, run.status);

      const sameColumn = fresh.column === request.to;
      const position =
        sameColumn && request.source === 'automatic'
          ? fresh.position
          : await this.place(tx, fresh, request.to, request.index);
      const accept = decision.effects.includes('accept');
      const reopen = decision.effects.includes('reopen');
      // #244 D8: the evidence is content; an accepted card keeps none.
      const suggestion = decision.effects.includes('accept_suggestion');
      await tx.boardCard.update({
        where: { id: fresh.id },
        data: {
          column: request.to,
          position,
          ...(sameColumn
            ? {}
            : { movedAt: now, movedById: actor.userId ?? null }),
          ...(accept ? { completedAt: now, completedById: actor.userId } : {}),
          ...(reopen ? { completedAt: null, completedById: null } : {}),
          ...(suggestion ? { evidence: Prisma.DbNull } : {}),
        },
      });
      return { fresh, decision, ended };
    });

    const { fresh, decision, ended } = outcome;
    const round = fresh.rounds[0] ?? null;
    const target = { type: 'board_card', id: fresh.id };
    if (fresh.column !== request.to || request.source === 'person') {
      await this.audit.record({
        ...actor.ctx,
        action: 'card.moved',
        target,
        projectId: project.id,
        before: { column: fresh.column },
        after: {
          number: fresh.number,
          column: request.to,
          index: request.index,
          source: request.source,
          effects: decision.allowed ? decision.effects : [],
        },
        result: 'ok',
      });
    }
    const effects: BoardMoveEffect[] = decision.allowed ? decision.effects : [];
    if (effects.includes('stop')) {
      await this.audit.record({
        ...actor.ctx,
        action: 'card.stopped',
        target,
        projectId: project.id,
        after: { number: fresh.number, round: round?.round, stopped },
        result: 'ok',
      });
    }
    if (effects.includes('finish')) {
      await this.audit.record({
        ...actor.ctx,
        action: 'card.finished',
        target,
        projectId: project.id,
        after: {
          number: fresh.number,
          round: round?.round,
          finishedBy: request.finishedBy ?? 'person',
        },
        result: 'ok',
      });
    }
    if (effects.includes('accept')) {
      await this.audit.record({
        ...actor.ctx,
        action: 'card.accepted',
        target,
        projectId: project.id,
        after: { number: fresh.number },
        result: 'ok',
      });
    }
    if (effects.includes('accept_suggestion')) {
      await this.audit.record({
        ...actor.ctx,
        action: 'card.inbox_accepted',
        target,
        projectId: project.id,
        after: {
          number: fresh.number,
          captureId: fresh.captureId,
          ...(request.edits ?? {}),
        },
        result: 'ok',
      });
    }
    for (const run of ended) this.publishRun(project.id, run.runId, run.status);
    this.publish(project.id, fresh.id);
    if (effects.includes('collect')) this.collect(fresh.id);
    if (effects.includes('accept') && fresh.branch !== null) {
      this.close(project, fresh.id, actor);
    }
  }

  private decide(
    card: CardWithRounds,
    request: MoveRequest,
  ): BoardMoveDecision {
    return boardMoveRule({
      from: card.column,
      to: request.to,
      roundPhase: card.rounds[0]?.phase ?? null,
      source: request.source,
      stopWorker: request.stopWorker,
      // #282: a fleet card follows its slot; a terminal card collects only
      // with Automatic work on.
      cardSource: card.source,
      autoCollect: card.autoCollect,
    });
  }

  /** The position for `index` in `column`, rebalancing it when it is too tight. */
  async place(
    tx: Tx,
    card: { id: string; projectId: string },
    column: BoardColumn,
    index: number,
  ): Promise<number> {
    const siblings = await tx.boardCard.findMany({
      where: { projectId: card.projectId, column, id: { not: card.id } },
      orderBy: [{ position: 'asc' }, { number: 'asc' }],
      select: { id: true, position: true },
    });
    const position = positionForIndex(
      siblings.map((s) => s.position),
      index,
    );
    if (position !== null) return position;
    const spaced = rebalancedPositions(siblings.length);
    for (const [i, sibling] of siblings.entries()) {
      await tx.boardCard.update({
        where: { id: sibling.id },
        data: { position: spaced[i] },
      });
    }
    return positionForIndex(spaced, index) ?? 0;
  }

  /**
   * Ends an active round once: the update matches only an active phase, so a
   * replayed event or a race finds nothing to do. Returns whether it ended it.
   */
  async endRound(
    tx: Tx,
    roundId: string,
    phase: 'finished' | 'failed' | 'cancelled',
    now: Date,
    extra: {
      finishedBy?: CardFinishedBy;
      summary?: string;
      exitCode?: number;
      error?: string;
      endedAt?: Date;
    } = {},
  ): Promise<boolean> {
    const { count } = await tx.boardCardRound.updateMany({
      where: { id: roundId, phase: { in: ACTIVE_PHASES } },
      data: {
        phase,
        finishedAt: now,
        ...(phase === 'finished'
          ? { finishedBy: extra.finishedBy ?? 'person' }
          : {}),
        ...(extra.summary !== undefined ? { summary: extra.summary } : {}),
        ...(extra.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
        ...(extra.error !== undefined
          ? { error: extra.error.slice(0, 500) }
          : {}),
        ...(extra.endedAt !== undefined ? { endedAt: extra.endedAt } : {}),
      },
    });
    return count > 0;
  }

  /** Ends the round's run (#21) once, with its duration. */
  async closeRun(
    tx: Tx,
    runId: string,
    status: RunStatus,
    outcome?: string,
  ): Promise<void> {
    const run = await tx.run.findUnique({
      where: { id: runId },
      select: { startedAt: true, endedAt: true },
    });
    if (!run || run.endedAt !== null) return;
    const now = new Date();
    await tx.run.update({
      where: { id: runId },
      data: {
        status,
        endedAt: now,
        durationMs: now.getTime() - run.startedAt.getTime(),
        updatedAt: now,
        ...(outcome ? { outcome: outcome.slice(0, 500) } : {}),
      },
    });
  }

  /** Sets a live run's status (running ↔ waiting for a person). */
  async runStatus(tx: Tx, runId: string, status: RunStatus): Promise<boolean> {
    const { count } = await tx.run.updateMany({
      where: { id: runId, endedAt: null, status: { not: status } },
      data: { status, updatedAt: new Date() },
    });
    return count > 0;
  }

  /** D7 `stop`: kills the worker's tmux session. */
  private async stopOnRunner(
    project: BoardProject,
    card: CardWithRounds,
    actor: BoardActor,
  ): Promise<boolean> {
    const output = boardOutput(
      'card.stop',
      await this.commands.send(
        project.runnerId,
        'card.stop',
        { cardId: card.id, projectId: project.id },
        { role: actor.role, ctx: actor.ctx },
      ),
    );
    return output.stopped;
  }

  /**
   * Stops the active round of a card in place (`POST …/stop`): the worker is
   * killed, the round `cancelled`, the card stays in its column.
   */
  async stop(
    project: BoardProject,
    card: CardWithRounds,
    actor: BoardActor,
  ): Promise<void> {
    const round = card.rounds[0];
    if (!round || !ACTIVE_PHASES.some((p) => p === round.phase)) {
      throw boardError(409, BOARD_ERROR.notRunning, 'No worker is running');
    }
    const stopped = await this.stopOnRunner(project, card, actor);
    const ended = await this.prisma.$transaction(async (tx) => {
      if (!(await this.endRound(tx, round.id, 'cancelled', new Date()))) {
        return false;
      }
      await this.closeRun(tx, round.runId, RUN_STATUS_OF.cancelled);
      return true;
    });
    await this.audit.record({
      ...actor.ctx,
      action: 'card.stopped',
      target: { type: 'board_card', id: card.id },
      projectId: project.id,
      after: { number: card.number, round: round.round, stopped },
      result: 'ok',
    });
    if (ended) this.publishRun(project.id, round.runId, 'abandoned');
    this.publish(project.id, card.id);
  }

  /**
   * D8, in the background: the runner's push can take up to 180 s. `move`
   * is the round's own collect; `retry` is #329 D4's automatic one.
   */
  collect(cardId: string, trigger: 'move' | 'retry' = 'move'): void {
    this.track(
      this.collectNow(cardId, trigger).then(
        () => undefined,
        (error: unknown) => {
          this.logger.error(
            `card.collect of ${cardId} failed`,
            error instanceof Error ? error.stack : String(error),
          );
        },
      ),
    );
  }

  /**
   * #329 D4, on the runner's `hello`: every card of its projects whose
   * collect failed, still in Finished, with automatic attempts left.
   */
  async retryCollectsOf(runnerId: string): Promise<void> {
    const cards = await this.prisma.boardCard.findMany({
      where: {
        project: { runnerId },
        ...RETRYABLE,
      },
      select: { id: true },
    });
    for (const card of cards) this.collect(card.id, 'retry');
  }

  /** D10, in the background: kill tmux, remove the worktree. Never merges. */
  close(project: BoardProject, cardId: string, actor: BoardActor): void {
    this.track(
      (async () => {
        try {
          boardOutput(
            'card.close',
            await this.commands.send(
              project.runnerId,
              'card.close',
              { cardId, projectId: project.id, removeWorktree: true },
              { role: actor.role, ctx: actor.ctx },
            ),
          );
        } catch (error) {
          this.logger.warn(
            `card.close of ${cardId} failed: ${(error as Error).message}`,
          );
        }
      })(),
    );
  }

  /**
   * #243 D2, in the background: `plan.close {planId: card.id}` drops the
   * card's design worktree on the runner, cancelling a design turn in it.
   */
  closeDesign(project: BoardProject, cardId: string, actor: BoardActor): void {
    this.track(
      (async () => {
        try {
          boardOutput(
            'plan.close',
            await this.commands.closeDesign(
              project.runnerId,
              { planId: cardId, projectId: project.id },
              { role: actor.role, ctx: actor.ctx },
            ),
          );
        } catch (error) {
          this.logger.warn(
            `plan.close of card ${cardId} failed: ${(error as Error).message}`,
          );
        }
      })(),
    );
  }

  /** Resolves once every background collect and close started so far has settled. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  private track(work: Promise<void>): void {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  /**
   * #329 D2: marks the card's collect `pending` and counts the attempt. The
   * round's own collect starts a new count; the manual one (D5) resets it
   * and is not counted; an automatic retry claims the card only while it is
   * still retryable (D4), so a timer and a `hello` never both run it, and a
   * card a person moved out of Finished is left alone.
   */
  private async claimCollect(
    cardId: string,
    trigger: CollectTrigger,
  ): Promise<boolean> {
    const { count } = await this.prisma.boardCard.updateMany({
      where:
        trigger === 'retry' ? { id: cardId, ...RETRYABLE } : { id: cardId },
      data: {
        collectState: 'pending',
        collectAttempts:
          trigger === 'retry' ? { increment: 1 } : trigger === 'move' ? 1 : 0,
      },
    });
    return count > 0;
  }

  /**
   * D8: commit leftovers, push, open a PR once; store it. Then D15's
   * `card.finished`, once per round, naming the PR when there is one.
   *
   * #329 D2: every attempt stores its outcome on the card, for every
   * source; D3: an open PR the runner reports fills a lost `prUrl`; D4: a
   * failed round's or manual collect is retried once after two minutes.
   * Returns the outcome, or `null` when there was no attempt.
   */
  async collectNow(
    cardId: string,
    trigger: CollectTrigger,
  ): Promise<CardCollectOutcome | null> {
    const card = await this.prisma.boardCard.findUnique({
      where: { id: cardId },
      include: {
        rounds: { orderBy: { round: 'desc' } },
        trackedSession: { select: { cwd: true, gitBranch: true } },
      },
    });
    // A board card that never ran has nothing to collect, and no failure.
    if (!card || (card.source !== 'terminal' && card.branch === null)) {
      return null;
    }
    if (!(await this.claimCollect(cardId, trigger))) return null;
    const outcome = await this.collectOnRunner(card);
    if (outcome.state === 'failed' && trigger !== 'retry') {
      // "Once after 2 minutes": only the attempt that opened the failure arms it.
      this.retryTimer.schedule(card.id, CARD_COLLECT_RETRY_DELAY_MS, () =>
        this.collect(card.id, 'retry'),
      );
    } else if (outcome.state !== 'failed') {
      this.retryTimer.cancel(card.id);
    }
    return outcome;
  }

  private async collectOnRunner(
    card: CardForCollect,
  ): Promise<CardCollectOutcome> {
    const terminal = card.source === 'terminal';
    // #282 D3: a terminal card collects in its tracked session's checkout.
    const target = terminal
      ? {
          branch: card.trackedSession?.gitBranch ?? null,
          cwd: card.trackedSession?.cwd || null,
        }
      : { branch: card.branch, cwd: null };
    if (target.branch === null || (terminal && target.cwd === null)) {
      // Only a terminal card gets here (`collectNow`).
      await this.terminalCollectFailed(card, TERMINAL_NO_BRANCH);
      return this.storeCollect(card, failedCollect(TERMINAL_NO_BRANCH));
    }
    const project = await this.project(card.projectId);
    if (terminal && target.branch === project.base) {
      // The base is never committed to or pushed by the board.
      const message = terminalOnBase(project.base);
      await this.terminalCollectFailed(card, message);
      return this.storeCollect(card, failedCollect(message));
    }
    const round = card.rounds[0] ?? null;
    let pr = { prNumber: card.prNumber, prUrl: card.prUrl };
    let outcome: CardCollectOutcome;
    try {
      const summary =
        card.rounds.find((r) => r.summary !== null)?.summary ?? null;
      const output = boardOutput(
        'card.collect',
        await this.commands.send(
          project.runnerId,
          'card.collect',
          {
            cardId: card.id,
            projectId: project.id,
            root: project.rootPath,
            base: project.base,
            branch: target.branch,
            ...(target.cwd === null ? {} : { cwd: target.cwd }),
            number: card.number,
            title: `${cardLabel(card.number)}: ${card.title}`.slice(0, 256),
            body: cardPullRequestBody({
              number: card.number,
              summary,
              issueNumber: card.issueNumber,
              specPrUrl: card.specPrUrl,
            }),
          },
          { role: 'operator', ctx: { actor: SYSTEM_ACTOR } },
        ),
      );
      const { prNumber, prUrl } = output;
      // D3: the open PR, new or existing.
      const open = prNumber !== undefined && prUrl !== undefined;
      if (open) pr = { prNumber, prUrl };
      outcome = open
        ? {
            state: 'ok',
            error: null,
            ahead: output.ahead,
            prNumber,
            prUrl,
          }
        : output.ahead === 0
          ? {
              state: 'no_changes',
              error: null,
              ahead: 0,
              prNumber: null,
              prUrl: null,
            }
          : { ...failedCollect(PUSHED_WITHOUT_PR), ahead: output.ahead };
      // A terminal card's earlier failure no longer holds once one succeeds.
      const cleared =
        terminal && card.autoRunError !== null && outcome.state !== 'failed';
      await this.storeCollect(card, outcome, {
        // An older runner reports no state: its PR is open (D6).
        ...(open ? { ...pr, prState: output.prState ?? 'open' } : {}),
        ...(cleared
          ? {
              autoRunError: null,
              autoRunMessage: null,
              autoRunFailedAt: null,
            }
          : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `card.collect of ${cardLabel(card.number)} failed: ${message}`,
      );
      if (terminal) {
        await this.terminalCollectFailed(
          card,
          `Collecting the session's work failed: ${message}`,
          error instanceof BoardFailure ? error.code : 'unknown',
        );
      }
      outcome = await this.storeCollect(card, failedCollect(message));
    }
    await this.finished(project, card, round, pr);
    return outcome;
  }

  /** #329 D2: the outcome of one collect attempt, on the card. */
  private async storeCollect(
    card: Pick<BoardCard, 'id' | 'projectId'>,
    outcome: CardCollectOutcome,
    extra: Prisma.BoardCardUpdateInput = {},
  ): Promise<CardCollectOutcome> {
    await this.prisma.boardCard.update({
      where: { id: card.id },
      data: {
        ...extra,
        collectState: outcome.state,
        collectError: outcome.error,
        collectedAt: new Date(),
      },
    });
    this.publish(card.projectId, card.id);
    return outcome;
  }

  /** D15: `card.finished`, once per round, naming the PR when there is one. */
  private async finished(
    project: BoardProject,
    card: CardForCollect,
    round: CardForCollect['rounds'][number] | null,
    pr: { prNumber: number | null; prUrl: string | null },
  ): Promise<void> {
    if (!round || round.finishedBy === null) return;
    const data: CardFinishedEventData = {
      cardId: card.id,
      number: card.number,
      title: card.title,
      round: round.round,
      finishedBy: round.finishedBy,
      prNumber: pr.prNumber,
      prUrl: pr.prUrl,
    };
    await this.prisma.$transaction((tx) =>
      this.serverEvent(tx, project, CARD_FINISHED_EVENT, round.id, {
        ...data,
      }),
    );
  }

  /**
   * #282 D3: Automatic work on a `terminal` card that collected nothing —
   * the session has no checkout to collect, or the runner refused or failed.
   * The card says why (`autoRunFailure`) and has no new PR.
   */
  private async terminalCollectFailed(
    card: BoardCard,
    message: string,
    code: CardAutoRunFailure['code'] = 'unknown',
  ): Promise<void> {
    await this.prisma.boardCard.update({
      where: { id: card.id },
      data: {
        autoRunError: code,
        autoRunMessage: message.slice(0, 500),
        autoRunFailedAt: new Date(),
      },
    });
    await this.audit.record({
      actor: SYSTEM_ACTOR,
      action: 'card.auto_run_failed',
      target: { type: 'board_card', id: card.id },
      projectId: card.projectId,
      // `error`, not `code`: the audit redacts every `code` key.
      after: {
        number: card.number,
        reason: 'terminal_collect_failed',
        error: code,
      },
      result: 'ok',
    });
    this.publish(card.projectId, card.id);
  }

  /** A `card.*` server event (ADR-0014), once per key. */
  serverEvent(
    tx: Tx,
    project: Pick<BoardProject, 'runnerId' | 'rootPath' | 'repo'>,
    type: string,
    key: string,
    data: Prisma.InputJsonObject,
  ): Promise<boolean> {
    return recordServerEvent(tx, {
      source: API_EVENT_SOURCE,
      type,
      ts: new Date(),
      project: {
        runnerId: project.runnerId,
        rootPath: project.rootPath,
        repo: project.repo,
      },
      data,
      dedupeKey: `${type}:${key}`,
    });
  }

  publish(projectId: string, cardId: string): void {
    const data: BoardChangedData = { cardId };
    try {
      this.live.publish(`project:${projectId}`, BOARD_CHANGED_EVENT, data);
    } catch (error) {
      this.logger.warn(
        `board.changed ${cardId} not published: ${(error as Error).message}`,
      );
    }
  }

  publishRun(projectId: string, runId: string, status: RunStatus): void {
    const change: RunLiveChange = { id: runId, status };
    try {
      this.live.publish(`project:${projectId}`, RUN_UPDATED_LIVE_EVENT, change);
    } catch (error) {
      this.logger.warn(
        `run.updated ${runId} not published: ${(error as Error).message}`,
      );
    }
  }
}
