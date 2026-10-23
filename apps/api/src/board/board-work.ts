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
  type CardMergeOutcome,
  type CardNeedsPersonReason,
  type CardPrState,
  cardLabel,
  cardPullRequestBody,
  isActiveRoundPhase,
  isDependencySatisfied,
  isDivergedBranchError,
  positionForIndex,
  type Role,
  RUN_UPDATED_LIVE_EVENT,
  type RunLiveChange,
  rebalancedPositions,
} from '@nautelle/shared';
import {
  API_EVENT_SOURCE,
  type CardPrOpenResult,
} from '@nautelle/shared/protocol';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type BoardCard, Prisma, type RunStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { type AuditContext, SYSTEM_ACTOR } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { LiveService } from '../live/live.service';
import { mergeMethodOf } from '../planner/planner-instructions.service';
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
  /**
   * #359 D7, C-148: the repository's default branch as the last inspection
   * read it (`Project.defaultBranch`). `null` when unknown — a card then
   * never ships itself.
   */
  defaultBranch: string | null;
  defaultProfileId: string | null;
  codeSentinelConfig: Prisma.JsonValue;
  /** #379: where a card's spec goes (`resolveSpecTarget`). */
  docsSource: SpecTargetProject['docsSource'];
}

/**
 * #359 D6, D7: what a card that ships itself does after its round's collect.
 * `BoardShipping` registers it; `BoardWork` cannot depend on it (it starts
 * rounds, which move cards through here).
 */
export type RoundCollectedHook = (
  cardId: string,
  outcome: CardCollectOutcome | null,
) => Promise<void>;

/**
 * #443, #638: what follows a card entering Finished or Completed — Auto-run
 * when ready of the cards that depend on it. `BoardAutoRun` registers it;
 * `BoardWork` cannot depend on it (it starts rounds, which move cards
 * through here).
 */
export type CardSatisfiedHook = (
  projectId: string,
  card: Pick<BoardCard, 'id' | 'number'>,
  actor: BoardActor,
) => Promise<void>;

/**
 * #652: what follows any change of a card — Run stack re-evaluates its
 * queue. `BoardStackRuns` registers it; `BoardWork` cannot depend on it (it
 * starts rounds, which move cards through here). It must not throw.
 */
export type CardChangedHook = (projectId: string, cardId: string) => void;

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

/**
 * #630: the reason `needsPerson` is set with when the runner refused to push
 * a branch whose remote holds commits the card's branch never had.
 */
export const BRANCH_DIVERGED =
  'branch_diverged' satisfies CardNeedsPersonReason;

/** #709: the forward PR of a merge into a dead dependency branch conflicts. */
const FORWARD_CONFLICT = 'forward_conflict' satisfies CardNeedsPersonReason;
/** #709: the forward PR could not be opened. */
const FORWARD_FAILED = 'forward_failed' satisfies CardNeedsPersonReason;

/** #709: `merge_failed`'s reason for a PR into a dependency branch that merged. */
const BASE_MERGED = 'base_merged';

/** #709: a card PR as GitHub has it now (`card.checks`). */
export interface LivePr {
  state: 'open' | 'draft' | 'merged' | 'closed';
  /** The branch it goes (or went) into; null from a runner before #709. */
  base: string | null;
  mergedAt: Date | null;
}

/** #709: why a forward PR exists, leading its body. */
const forwardSummary = (
  card: Pick<BoardCard, 'number' | 'prNumber'>,
  into: string | null,
  base: string,
): string =>
  `${cardLabel(card.number)} merged in #${card.prNumber} into \`${into ?? 'its dependency branch'}\` after that branch's own pull request had merged, so its work never reached \`${base}\`. This pull request carries it forward.`;

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
  /**
   * #359: `false` skips the `collect` effect — the round's collect already
   * ran while the card stayed In progress.
   */
  collect?: false;
}

/** The message of each `move_refused` reason. */
const MOVE_REFUSED: Record<
  Exclude<BoardMoveRefusal, 'card_running' | 'invalid_move'>,
  string
> = {
  automatic_to_completed: 'Only a person completes a card',
  card_completed: 'A completed card is moved only by a person',
  plan_task_derived: 'A completed card is moved only by a person',
  // #282 D4: the column follows the slot; #424: until the slot is gone.
  fleet_slot:
    'A fleet card follows its live slot: the one move it takes is Finished → Completed',
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
  private roundCollected: RoundCollectedHook | null = null;
  private cardSatisfied: CardSatisfiedHook | null = null;
  private cardChanged: CardChangedHook | null = null;
  private readonly watchers = new Set<CardChangedHook>();

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
        defaultBranch: true,
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
      defaultBranch: row.defaultBranch,
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
    // #359 D7: the work never moves a card that ships itself to Finished on
    // its own; the round ends in place and CI decides. `collect: false` is
    // that decision: the round's collect has run.
    if (
      request.to === 'finished' &&
      request.source === 'automatic' &&
      request.collect !== false &&
      card.column === 'in_progress' &&
      this.ships(project, card)
    ) {
      await this.finishInPlace(project, card, request, actor);
      return;
    }
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
    // #443, #638: entering or leaving Finished / Completed changes Ready /
    // Waiting — and whether Run is open — of the cards that wait for it.
    const entered = fresh.column !== request.to;
    if (
      entered &&
      (isDependencySatisfied(fresh.column) || isDependencySatisfied(request.to))
    ) {
      await this.publishDependants(project.id, fresh.id);
    }
    // #638: reaching Finished satisfies a dependency, and so does Accept; the
    // auto-run's claim lets a dependant start once, whichever comes first.
    const hook = this.cardSatisfied;
    const satisfied =
      hook &&
      (effects.includes('accept') || (entered && request.to === 'finished'))
        ? () =>
            hook(project.id, fresh, actor).catch((error: unknown) => {
              this.logger.error(
                `the auto-run after ${cardLabel(fresh.number)} failed`,
                error instanceof Error ? error.stack : String(error),
              );
            })
        : null;
    if (effects.includes('collect') && request.collect !== false) {
      // #636: a dependant is stacked on this card's PR, which the collect
      // opens — so the auto-run waits for it.
      this.collect(fresh.id, 'move', satisfied);
    } else if (satisfied) {
      this.track(satisfied());
    }
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
      // #424: a gone slot no longer moves its card, so a person may.
      // #433: a card with no slot at all has nothing to follow either.
      slotGone: card.fleetSlotGone || card.fleetSlot === null,
    });
  }

  /**
   * #359: a card that ships itself — a card worker's card (not a fleet slot,
   * not a tracked terminal session) that has run, on a runner that
   * advertises `card.checks`.
   */
  ships(
    project: Pick<BoardProject, 'runnerId'>,
    card: Pick<BoardCard, 'source' | 'branch'>,
  ): boolean {
    return (
      card.source !== 'fleet' &&
      card.source !== 'terminal' &&
      card.branch !== null &&
      this.commands.servesChecks(project.runnerId)
    );
  }

  /** #443, #638: `BoardAutoRun` registers what follows Finished or Accept. */
  onSatisfied(hook: CardSatisfiedHook): void {
    this.cardSatisfied = hook;
  }

  /** #652: `BoardStackRuns` registers what follows any change of a card. */
  onChanged(hook: CardChangedHook): void {
    this.cardChanged = hook;
  }

  /**
   * #845 (ADR-0083 §7): a held `board.wait` is woken early by any change of
   * a card on this instance. Best effort — the wait re-diffs on a tick too.
   * Returns the unsubscribe.
   */
  watch(listener: CardChangedHook): () => void {
    this.watchers.add(listener);
    return () => {
      this.watchers.delete(listener);
    };
  }

  /** #359: `BoardShipping` registers what follows a round's collect. */
  onRoundCollected(hook: RoundCollectedHook): void {
    this.roundCollected = hook;
  }

  /**
   * #359 D7: the worker is done, but Finished waits for CI. The round ends
   * (`finish`), the card stays In progress, and the collect — the last push,
   * the PR out of draft, its description (D3) — runs in the background;
   * `BoardShipping` reads the checks after it.
   */
  private async finishInPlace(
    project: BoardProject,
    card: CardWithRounds,
    request: MoveRequest,
    actor: BoardActor,
  ): Promise<void> {
    const now = new Date();
    const finishedBy = request.finishedBy ?? 'person';
    // The sink ends a round whose session ended before it moves the card;
    // the worker's `finish_card` ends it here.
    const { round, ended } = await this.prisma.$transaction(async (tx) => {
      const fresh = await this.lock(tx, card.id);
      const latest = fresh.rounds[0] ?? null;
      if (!latest || !isActiveRoundPhase(latest.phase)) {
        return { round: latest, ended: false };
      }
      if (
        !(await this.endRound(tx, latest.id, 'finished', now, {
          finishedBy,
          summary: request.summary,
        }))
      ) {
        return { round: null, ended: false };
      }
      await this.closeRun(tx, latest.runId, 'succeeded');
      return { round: latest, ended: true };
    });
    if (!round) return;
    if (ended) {
      await this.audit.record({
        ...actor.ctx,
        action: 'card.finished',
        target: { type: 'board_card', id: card.id },
        projectId: project.id,
        after: { number: card.number, round: round.round, finishedBy },
        result: 'ok',
      });
      this.publishRun(project.id, round.runId, 'succeeded');
    }
    this.publish(project.id, card.id);
    this.track(
      (async () => {
        const outcome = await this.collectNow(card.id, 'move');
        await this.roundCollected?.(card.id, outcome);
      })().catch((error: unknown) => {
        this.logger.error(
          `the round end of ${cardLabel(card.number)} failed`,
          error instanceof Error ? error.stack : String(error),
        );
      }),
    );
  }

  /**
   * #273 D13, #359 D7: `card.merge` of the card's PR at `headSha`, audited
   * — Accept's, or the auto-merge's by the system actor. A refusal is 409
   * `merge_failed`. A merge records `prState merged`, `mergedAt` and the PR
   * row's state (D8).
   */
  async mergePr(
    project: BoardProject,
    card: Pick<
      CardWithRounds,
      'id' | 'number' | 'prNumber' | 'issueNumber' | 'rounds'
    >,
    headSha: string,
    deleteBranch: boolean,
    actor: BoardActor,
  ): Promise<CardMergeOutcome> {
    if (isActiveRoundPhase(card.rounds[0]?.phase)) {
      throw boardError(
        409,
        BOARD_ERROR.cardRunning,
        'A worker is running on this card',
      );
    }
    const pr = card.prNumber;
    if (pr === null) {
      throw boardError(
        409,
        BOARD_ERROR.noPullRequest,
        `${cardLabel(card.number)} has no pull request to merge`,
      );
    }
    await this.assertLiveBase(project, card.id);
    const output = boardOutput(
      'card.merge',
      await this.commands.send(
        project.runnerId,
        'card.merge',
        {
          cardId: card.id,
          projectId: project.id,
          root: project.rootPath,
          pr,
          headSha,
          method: mergeMethodOf(project.codeSentinelConfig),
          issue: card.issueNumber,
          comment: `Completed as ${cardLabel(card.number)} on the Nautelle board; merged in #${pr}.`,
          // #329 D9: an older runner refuses the arg; it is sent only when asked.
          ...(deleteBranch ? { deleteBranch } : {}),
        },
        { role: actor.role, ctx: actor.ctx },
      ),
    );
    const target = { type: 'board_card', id: card.id } as const;
    if (!output.merged) {
      await this.audit.record({
        ...actor.ctx,
        action: 'card.merge_failed',
        target,
        projectId: project.id,
        after: { number: card.number, pr, reason: output.error },
        result: 'error',
        meta: { message: output.message },
      });
      throw boardError(
        409,
        BOARD_ERROR.mergeFailed,
        output.message || `The merge of #${pr} was refused`,
        { reason: output.error },
      );
    }
    await this.audit.record({
      ...actor.ctx,
      action: 'card.merged',
      target,
      projectId: project.id,
      after: {
        number: card.number,
        pr,
        method: output.method,
        ...(output.mergeCommit !== null
          ? { mergeCommit: output.mergeCommit }
          : {}),
        alreadyMerged: output.alreadyMerged,
        issueClosed: output.issueClosed,
        branchDeleted: output.branchDeleted,
      },
      result: 'ok',
    });
    // #329 D6: the card's PR state from the merge result; #359 D8: Merged.
    await this.markMerged(card.id, pr);
    return {
      merged: true,
      alreadyMerged: output.alreadyMerged,
      method: output.method,
      mergeCommit: output.mergeCommit,
      issueClosed: output.issueClosed,
      ...(output.issueError !== undefined
        ? { issueError: output.issueError }
        : {}),
      branchDeleted: output.branchDeleted,
      ...(output.branchError !== undefined
        ? { branchError: output.branchError }
        : {}),
    };
  }

  /**
   * #359 D8: a PR of the card, listed once; a later report updates its state.
   * The round is the one that opened it, kept.
   */
  async recordPullRequest(
    cardId: string,
    pr: {
      number: number;
      url: string;
      branch: string;
      state: CardPrState;
      round: number;
    },
  ): Promise<void> {
    await this.prisma.boardCardPullRequest.upsert({
      where: { cardId_number: { cardId, number: pr.number } },
      create: { cardId, ...pr },
      update: { url: pr.url, state: pr.state },
    });
  }

  /**
   * #709: a stacked PR is never merged into a dependency branch whose own PR
   * has merged — its work would never reach the project base. A dependency
   * merged on GitHub is recorded first, and the PR moved onto the base; one
   * that cannot be moved is refused, 409 `merge_failed` with the reason
   * `base_merged`. A PR into a live dependency branch merges as before.
   */
  private async assertLiveBase(
    project: BoardProject,
    cardId: string,
  ): Promise<void> {
    const card = await this.prisma.boardCard.findUnique({
      where: { id: cardId },
      include: { rounds: { orderBy: { round: 'desc' } } },
    });
    if (!card || card.prBaseCardId === null) return;
    // #722: a PR a person moved onto the base on GitHub merges into the base.
    const live = await this.livePr(project, card);
    if (
      card.prNumber !== null &&
      (await this.adoptLiveBase(
        project,
        card.id,
        card.prNumber,
        live?.base ?? null,
      ))
    ) {
      return;
    }
    if (!(await this.retargetIfDue(project, card))) return;
    const fresh = await this.prisma.boardCard.findUnique({
      where: { id: cardId },
      select: { prBase: true, prBaseCard: { select: { mergedAt: true } } },
    });
    if (!fresh?.prBaseCard?.mergedAt) return;
    throw boardError(
      409,
      BOARD_ERROR.mergeFailed,
      `${cardLabel(card.number)}'s pull request goes into ${fresh.prBase}, whose own pull request has merged, and it could not be moved onto ${project.base}`,
      { reason: BASE_MERGED },
    );
  }

  /**
   * #359 D8: the card's PR `pr` merged — the card's state and its PR row.
   * #709: `facts` is what GitHub says of the merge, when it was read: the
   * branch it went into and when. A stacked PR that went into the project
   * base itself (GitHub moved it there) is no longer stacked; one that went
   * into its dependency's branch after that branch's own PR merged is
   * carried forward (`retarget`).
   */
  async markMerged(
    cardId: string,
    pr: number,
    facts: LivePr | null = null,
  ): Promise<void> {
    const card = await this.prisma.boardCard.findUnique({
      where: { id: cardId },
      select: { projectId: true, prBaseCardId: true },
    });
    if (!card) return;
    const project = await this.project(card.projectId);
    const intoBase = facts?.base === project.base;
    const [{ count }] = await this.prisma.$transaction([
      this.prisma.boardCard.updateMany({
        where: { id: cardId, prNumber: pr },
        data: { prState: 'merged', mergedAt: facts?.mergedAt ?? new Date() },
      }),
      this.prisma.boardCardPullRequest.updateMany({
        where: { cardId, number: pr },
        data: { state: 'merged' },
      }),
    ]);
    // #722: a stacked PR that went into the base is no longer stacked.
    if (count > 0 && intoBase) {
      await this.adoptLiveBase(project, cardId, pr, facts?.base ?? null);
    }
    if (count > 0 && !intoBase && card.prBaseCardId !== null) {
      await this.settleStacked(project, cardId, card.prBaseCardId);
    }
    this.publish(project.id, cardId);
    await this.restack(cardId);
  }

  /**
   * #722: GitHub's base of the card's PR `pr`, read through `card.checks`. A
   * stacked card whose PR goes (or went) into the project base — a person
   * retargeted it there by hand, or GitHub did when the dependency's branch
   * was deleted — is no longer stacked: its stored base is cleared and the
   * change audited as `card.pr_retargeted` `by: github`. Returns whether it
   * was.
   */
  async adoptLiveBase(
    project: BoardProject,
    cardId: string,
    pr: number,
    base: string | null,
  ): Promise<boolean> {
    if (base === null || base !== project.base) return false;
    const card = await this.prisma.boardCard.findUnique({
      where: { id: cardId },
      select: {
        number: true,
        prNumber: true,
        prBase: true,
        prBaseCard: { select: { number: true } },
      },
    });
    if (!card || card.prBase === null || card.prNumber !== pr) return false;
    const { count } = await this.prisma.boardCard.updateMany({
      where: { id: cardId, prNumber: pr, prBase: card.prBase },
      data: { prBase: null, prBaseCardId: null },
    });
    if (count === 0) return false;
    await this.audit.record({
      actor: SYSTEM_ACTOR,
      action: 'card.pr_retargeted',
      target: { type: 'board_card', id: cardId },
      projectId: project.id,
      after: {
        number: card.number,
        pr,
        from: card.prBase,
        base,
        dependency: card.prBaseCard?.number ?? null,
        by: 'github',
      },
      result: 'ok',
    });
    this.publish(project.id, cardId);
    return true;
  }

  /**
   * #722: a card recorded as merged with a stored base is read on GitHub
   * again — its PR may have been retargeted onto the project base by hand
   * before it merged, so its work is in the base whatever the stored base
   * says. Returns whether the stored base was cleared, or null when the
   * runner could not answer.
   */
  async refreshMergedBase(
    project: BoardProject,
    card: { id: string; prNumber: number | null },
  ): Promise<boolean | null> {
    if (card.prNumber === null) return false;
    const live = await this.livePr(project, card);
    if (live === null) return null;
    if (live.state !== 'merged') return false;
    return this.adoptLiveBase(project, card.id, card.prNumber, live.base);
  }

  /**
   * #709: the stacked card `cardId` merged into its dependency's branch. If
   * the dependency has merged too — on GitHub, when the board has not seen it
   * — the card is settled now: landed with the dependency, or carried
   * forward. Otherwise it lands when the dependency does (`restack`).
   */
  private async settleStacked(
    project: BoardProject,
    cardId: string,
    dependencyId: string,
  ): Promise<void> {
    if ((await this.dependencyMergedAt(project, dependencyId)) === null) return;
    const card = await this.prisma.boardCard.findUnique({
      where: { id: cardId },
      include: { rounds: { orderBy: { round: 'desc' } } },
    });
    // Recording the dependency's merge restacked the card already.
    if (!card || card.prBaseCardId !== dependencyId) return;
    try {
      await this.retarget(project, card);
    } catch (error) {
      if (!(error instanceof BoardFailure)) throw error;
      this.logger.warn(
        `${cardLabel(card.number)} not settled onto ${project.base}: ${error.message}`,
      );
    }
  }

  /**
   * #709: a card PR as GitHub has it now, read through `card.checks`; null
   * when the runner does not serve it or cannot answer.
   */
  async livePr(
    project: BoardProject,
    card: { id: string; prNumber: number | null },
  ): Promise<LivePr | null> {
    if (card.prNumber === null) return null;
    if (!this.commands.servesChecks(project.runnerId)) return null;
    try {
      const result = await this.commands.checks(
        project.runnerId,
        {
          cardId: card.id,
          projectId: project.id,
          root: project.rootPath,
          pr: card.prNumber,
        },
        { role: 'operator', ctx: { actor: SYSTEM_ACTOR } },
      );
      if (result.status !== 'ok') return null;
      const { state, base, mergedAt } = result.output;
      return {
        state,
        base: base ?? null,
        mergedAt: mergedAt ? new Date(mergedAt) : null,
      };
    } catch (error) {
      if (error instanceof BoardFailure) return null;
      throw error;
    }
  }

  /**
   * #709: when the dependency's PR merged, or null while it has not. A
   * dependency the board holds as open is read on GitHub: a merge the PR
   * poll missed is recorded (`markMerged`, which restacks its dependants),
   * and a closed PR as closed.
   */
  async dependencyMergedAt(
    project: BoardProject,
    dependencyId: string,
  ): Promise<Date | null> {
    const dependency = await this.prisma.boardCard.findUnique({
      where: { id: dependencyId },
      select: { id: true, prNumber: true, prState: true, mergedAt: true },
    });
    if (!dependency) return null;
    if (dependency.mergedAt !== null) return dependency.mergedAt;
    const pr = dependency.prNumber;
    if (pr === null || dependency.prState === 'closed') return null;
    const live = await this.livePr(project, dependency);
    if (live?.state === 'closed') {
      await this.prisma.$transaction([
        this.prisma.boardCard.updateMany({
          where: { id: dependency.id, prNumber: pr },
          data: { prState: 'closed' },
        }),
        this.prisma.boardCardPullRequest.updateMany({
          where: { cardId: dependency.id, number: pr },
          data: { state: 'closed' },
        }),
      ]);
      this.publish(project.id, dependency.id);
      return null;
    }
    if (live?.state !== 'merged') return null;
    await this.markMerged(dependency.id, pr, live);
    const merged = await this.prisma.boardCard.findUnique({
      where: { id: dependency.id },
      select: { mergedAt: true },
    });
    return merged?.mergedAt ?? null;
  }

  /**
   * #636 (ADR-0064): the card merged — every card stacked on its branch goes
   * onto the project base: an open PR through `card.prRetarget`, then the
   * stored base is cleared. Never throws; what it could not do the PR poll
   * tries again (`retargetIfDue`). #709: a card carried forward has not
   * merged after all — what is stacked on its branch waits for its forward PR.
   */
  async restack(mergedCardId: string): Promise<void> {
    const merged = await this.prisma.boardCard.findUnique({
      where: { id: mergedCardId },
      select: { mergedAt: true },
    });
    if (merged?.mergedAt == null) return;
    const stacked = await this.prisma.boardCard.findMany({
      where: { prBaseCardId: mergedCardId },
      include: { rounds: { orderBy: { round: 'desc' } } },
    });
    if (stacked.length === 0) return;
    const project = await this.project(stacked[0].projectId);
    for (const card of stacked) {
      try {
        await this.retarget(project, card);
      } catch (error) {
        if (!(error instanceof BoardFailure)) throw error;
        this.logger.warn(
          `${cardLabel(card.number)} not retargeted onto ${project.base}: ${error.message}`,
        );
      }
    }
  }

  /**
   * #636: the PR poll's retry — a card stacked on a dependency that has
   * merged since goes onto the base. #709: a dependency the board holds as
   * open is read on GitHub first. Returns whether it is still stacked.
   */
  async retargetIfDue(
    project: BoardProject,
    card: CardWithRounds,
  ): Promise<boolean> {
    if (card.prBaseCardId === null) return card.prBase !== null;
    if ((await this.dependencyMergedAt(project, card.prBaseCardId)) === null) {
      return true;
    }
    // Recording the dependency's merge may have restacked the card already.
    const fresh = await this.prisma.boardCard.findUnique({
      where: { id: card.id },
      include: { rounds: { orderBy: { round: 'desc' } } },
    });
    if (!fresh) return false;
    if (fresh.prBaseCardId === null) return fresh.prBase !== null;
    try {
      return !(await this.retarget(project, fresh));
    } catch (error) {
      if (!(error instanceof BoardFailure)) throw error;
      this.logger.warn(
        `${cardLabel(card.number)} not retargeted onto ${project.base}: ${error.message}`,
      );
      return true;
    }
  }

  /**
   * #636: one stacked card onto the base, its dependency merged. A card with
   * an open PR is retargeted first; one whose round is still running without
   * a PR keeps its base — the PR it opens is retargeted by the poll. #709: a
   * card whose PR merged into the dependency's branch before the dependency
   * merged landed with it; one that merged there after (or whose PR GitHub
   * reports merged when the retarget comes) is carried forward. Returns
   * whether the card's base is the project base now.
   */
  private async retarget(
    project: BoardProject,
    card: CardWithRounds,
  ): Promise<boolean> {
    const from = card.prBase;
    if (card.mergedAt !== null && card.prBaseCardId !== null) {
      const dependency = await this.prisma.boardCard.findUnique({
        where: { id: card.prBaseCardId },
        select: { mergedAt: true },
      });
      if (dependency?.mergedAt && card.mergedAt >= dependency.mergedAt) {
        return this.forward(project, card);
      }
    }
    const openPr =
      card.prNumber !== null &&
      card.mergedAt === null &&
      card.prState !== 'merged' &&
      card.prState !== 'closed';
    if (!openPr && isActiveRoundPhase(card.rounds[0]?.phase)) return false;
    let notOpen = false;
    if (openPr && card.prNumber !== null) {
      if (!this.commands.servesPrRetarget(project.runnerId)) return false;
      const result = boardOutput(
        'card.prRetarget',
        await this.commands.retargetPr(
          project.runnerId,
          {
            cardId: card.id,
            projectId: project.id,
            root: project.rootPath,
            pr: card.prNumber,
            base: project.base,
          },
          { role: 'operator', ctx: { actor: SYSTEM_ACTOR } },
        ),
      );
      // A PR that is no longer open has nothing to retarget; the card's next
      // PR goes into the base. Any other refusal is tried again by the poll.
      if (!result.retargeted && result.error !== 'not_open') {
        this.logger.warn(
          `${cardLabel(card.number)}: card.prRetarget ${result.error} — ${result.message}`,
        );
        return false;
      }
      if (!result.retargeted) {
        // #709: a PR that merged into the dead branch is carried forward.
        const settled = await this.settleClosedPr(project, card);
        if (settled !== null) return settled;
        notOpen = true;
      }
    }
    const { count } = await this.prisma.boardCard.updateMany({
      where: { id: card.id, prBaseCardId: card.prBaseCardId },
      data: { prBase: null, prBaseCardId: null },
    });
    if (count > 0 && openPr && !notOpen) {
      const dependency = card.prBaseCardId
        ? await this.prisma.boardCard.findUnique({
            where: { id: card.prBaseCardId },
            select: { number: true },
          })
        : null;
      await this.audit.record({
        actor: SYSTEM_ACTOR,
        action: 'card.pr_retargeted',
        target: { type: 'board_card', id: card.id },
        projectId: project.id,
        after: {
          number: card.number,
          pr: card.prNumber,
          from,
          base: project.base,
          dependency: dependency?.number ?? null,
        },
        result: 'ok',
      });
    }
    this.publish(project.id, card.id);
    return true;
  }

  /**
   * #709: a stacked PR `card.prRetarget` found no longer open, read on
   * GitHub. A merge is recorded — `markMerged` carries it forward when it went
   * into the dead branch — and answers whether the card's base is the project
   * base now. A closed PR, or one the runner cannot read, answers null: the
   * stored base is simply cleared.
   */
  private async settleClosedPr(
    project: BoardProject,
    card: CardWithRounds,
  ): Promise<boolean | null> {
    const live = await this.livePr(project, card);
    if (live?.state !== 'merged' || card.prNumber === null) return null;
    await this.markMerged(card.id, card.prNumber, live);
    const fresh = await this.prisma.boardCard.findUnique({
      where: { id: card.id },
      select: { prBaseCardId: true },
    });
    return fresh?.prBaseCardId === null;
  }

  /**
   * #709 (ADR-0064): the card's PR merged into its dependency's branch after
   * that branch's own PR had merged, so its work never reached the project
   * base. `card.prOpen` opens a forward PR of the card's branch into the
   * base, and the card ships it like any PR; a forward PR that conflicts, or
   * one that could not be opened, needs a person. A branch with nothing the
   * base lacks has landed after all. Returns whether the card's base is the
   * project base now.
   */
  private async forward(
    project: BoardProject,
    card: CardWithRounds,
  ): Promise<boolean> {
    const into = card.prBase;
    const stacked = { id: card.id, prBaseCardId: card.prBaseCardId };
    const failed = async (message: string): Promise<boolean> => {
      const { count } = await this.prisma.boardCard.updateMany({
        where: stacked,
        data: { needsPerson: true, needsPersonReason: FORWARD_FAILED },
      });
      if (count > 0 && card.needsPersonReason !== FORWARD_FAILED) {
        await this.audit.record({
          actor: SYSTEM_ACTOR,
          action: 'card.auto_run_failed',
          target: { type: 'board_card', id: card.id },
          projectId: project.id,
          after: {
            number: card.number,
            reason: FORWARD_FAILED,
            pr: card.prNumber,
            into,
          },
          result: 'error',
          meta: { message },
        });
      }
      this.logger.warn(
        `${cardLabel(card.number)}: no forward PR into ${project.base} — ${message}`,
      );
      this.publish(project.id, card.id);
      return false;
    };
    if (card.branch === null) return failed('the card has no branch');
    if (!this.commands.servesPrOpen(project.runnerId)) {
      return failed('the runner does not serve card.prOpen; update it');
    }
    let output: CardPrOpenResult;
    try {
      output = boardOutput(
        'card.prOpen',
        await this.commands.openPr(
          project.runnerId,
          {
            cardId: card.id,
            projectId: project.id,
            root: project.rootPath,
            branch: card.branch,
            base: project.base,
            title: `${cardLabel(card.number)}: ${card.title}`.slice(0, 256),
            body: cardPullRequestBody({
              number: card.number,
              summary: forwardSummary(card, into, project.base),
              issueNumber: card.issueNumber,
              specPrUrl: card.specPrUrl,
            }),
          },
          { role: 'operator', ctx: { actor: SYSTEM_ACTOR } },
        ),
      );
    } catch (error) {
      if (!(error instanceof BoardFailure)) throw error;
      return failed(error.message);
    }
    if (!output.opened) {
      if (output.error !== 'no_commits') return failed(output.message);
      // Nothing to carry: the branch's work is in the base already.
      await this.prisma.boardCard.updateMany({
        where: stacked,
        data: { prBase: null, prBaseCardId: null },
      });
      this.publish(project.id, card.id);
      return true;
    }
    const conflict = output.mergeable === 'CONFLICTING';
    const { count } = await this.prisma.boardCard.updateMany({
      where: stacked,
      data: {
        prNumber: output.prNumber,
        prUrl: output.prUrl,
        prState: 'open',
        mergedAt: null,
        prBase: null,
        prBaseCardId: null,
        ciState: 'pending',
        ciFixAttempts: 0,
        needsPerson: false,
        needsPersonReason: null,
      },
    });
    if (count === 0) return false;
    await this.recordPullRequest(card.id, {
      number: output.prNumber,
      url: output.prUrl,
      branch: card.branch,
      state: 'open',
      round: card.rounds[0]?.round ?? 1,
    });
    const dependency = card.prBaseCardId
      ? await this.prisma.boardCard.findUnique({
          where: { id: card.prBaseCardId },
          select: { number: true },
        })
      : null;
    await this.audit.record({
      actor: SYSTEM_ACTOR,
      action: 'card.pr_forwarded',
      target: { type: 'board_card', id: card.id },
      projectId: project.id,
      after: {
        number: card.number,
        pr: output.prNumber,
        mergedPr: card.prNumber,
        into,
        base: project.base,
        dependency: dependency?.number ?? null,
        alreadyOpen: output.alreadyOpen,
        conflict,
      },
      result: 'ok',
    });
    if (conflict) {
      await this.forwardConflict(project, {
        id: card.id,
        number: card.number,
        prNumber: output.prNumber,
      });
    }
    this.publish(project.id, card.id);
    return true;
  }

  /**
   * #709 (ADR-0064, C-278): Completed means landed. What is missing for the
   * card's work to be in the project base, in one sentence — or null when it
   * is there, or there is none: no PR and no failed collect, a PR merged into
   * the base, or one merged into a dependency branch that has not merged yet
   * (it lands with it). An open PR is read on GitHub first, so a merge the
   * poll has not seen counts — and one into a dead branch is carried forward.
   */
  async missingLanding(
    project: BoardProject,
    cardId: string,
  ): Promise<string | null> {
    let card = await this.prisma.boardCard.findUnique({
      where: { id: cardId },
      include: { prBaseCard: { select: { number: true, mergedAt: true } } },
    });
    if (!card) return null;
    const pr = card.prNumber;
    if (pr !== null && card.mergedAt === null && card.prState !== 'closed') {
      const live = await this.livePr(project, card);
      if (live?.state === 'merged') {
        await this.markMerged(card.id, pr, live);
        card = await this.prisma.boardCard.findUnique({
          where: { id: cardId },
          include: {
            prBaseCard: { select: { number: true, mergedAt: true } },
          },
        });
        if (!card) return null;
      }
    } else if (card.mergedAt !== null && card.prBase !== null) {
      // #722: merged into the base after a retarget by hand on GitHub.
      if (await this.refreshMergedBase(project, card)) {
        card = await this.prisma.boardCard.findUnique({
          where: { id: cardId },
          include: {
            prBaseCard: { select: { number: true, mergedAt: true } },
          },
        });
        if (!card) return null;
      }
    }
    const label = cardLabel(card.number);
    if (card.prNumber === null) {
      return card.collectState === 'failed'
        ? `${label} has work on its branch that never went into a pull request into ${project.base}`
        : null;
    }
    const dependency = card.prBaseCard;
    if (card.mergedAt !== null) {
      if (card.prBase === null) return null;
      if (!dependency?.mergedAt || card.mergedAt < dependency.mergedAt) {
        return null;
      }
      return `${label}'s pull request #${card.prNumber} merged into ${card.prBase} after ${cardLabel(dependency.number)}'s own pull request had merged, so its work is not in ${project.base}`;
    }
    const into = card.prBase ?? project.base;
    return card.prState === 'closed'
      ? `${label}'s pull request #${card.prNumber} into ${into} was closed without merging, so its work is not in ${project.base}`
      : `${label}'s pull request #${card.prNumber} into ${into} has not merged, so its work is not in ${project.base} yet`;
  }

  /** #709: whether the card's PR `pr` is a forward PR (`card.pr_forwarded`). */
  async forwarded(cardId: string, pr: number): Promise<boolean> {
    const record = await this.prisma.auditRecord.findFirst({
      where: {
        action: 'card.pr_forwarded',
        targetType: 'board_card',
        targetId: cardId,
        after: { path: ['pr'], equals: pr },
      },
      select: { seq: true },
    });
    return record !== null;
  }

  /**
   * #709: the card's forward PR conflicts with the project base — a person
   * resolves it; nothing merges it meanwhile.
   */
  async forwardConflict(
    project: BoardProject,
    card: Pick<BoardCard, 'id' | 'number' | 'prNumber'>,
  ): Promise<void> {
    const { count } = await this.prisma.boardCard.updateMany({
      where: { id: card.id, prNumber: card.prNumber, needsPerson: false },
      data: { needsPerson: true, needsPersonReason: FORWARD_CONFLICT },
    });
    if (count === 0) return;
    await this.audit.record({
      actor: SYSTEM_ACTOR,
      action: 'card.auto_run_failed',
      target: { type: 'board_card', id: card.id },
      projectId: project.id,
      after: {
        number: card.number,
        reason: FORWARD_CONFLICT,
        pr: card.prNumber,
        base: project.base,
      },
      result: 'error',
    });
    this.publish(project.id, card.id);
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
   * is the round's own collect; `retry` is #329 D4's automatic one. `then`
   * runs once the collect settled, whatever its outcome (#638: the auto-run
   * of the cards that wait for this one).
   */
  collect(
    cardId: string,
    trigger: 'move' | 'retry' = 'move',
    then: (() => Promise<void>) | null = null,
  ): void {
    this.track(
      this.collectNow(cardId, trigger)
        .then(
          () => undefined,
          (error: unknown) => {
            this.logger.error(
              `card.collect of ${cardId} failed`,
              error instanceof Error ? error.stack : String(error),
            );
          },
        )
        .then(() => then?.()),
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

  /** #652: background work `settled` waits for, like a collect. */
  background(work: Promise<void>): void {
    this.track(work);
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
            // #636: a stacked card's PR goes into its dependency's branch.
            base: card.prBase ?? project.base,
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
      if (open) {
        await this.recordPullRequest(card.id, {
          number: prNumber,
          url: prUrl,
          branch: target.branch,
          state: output.prState ?? 'open',
          round: round?.round ?? 1,
        });
      }
      // A terminal card's earlier failure no longer holds once one succeeds.
      const cleared =
        terminal && card.autoRunError !== null && outcome.state !== 'failed';
      // #630: a person merged the diverged branch; automation resumes.
      const merged =
        card.needsPersonReason === BRANCH_DIVERGED &&
        outcome.state !== 'failed';
      await this.storeCollect(card, outcome, {
        ...(merged ? { needsPerson: false, needsPersonReason: null } : {}),
        // C-148: an older runner reports none; the card keeps what it had.
        ...(output.protectedPaths !== undefined
          ? { protectedPaths: output.protectedPaths }
          : {}),
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
      if (isDivergedBranchError(message)) {
        outcome = await this.divergedCollect(card, message);
      } else {
        outcome = await this.storeCollect(card, failedCollect(message));
      }
    }
    await this.finished(project, card, round, pr);
    return outcome;
  }

  /**
   * #630: the runner pushed nothing — `origin/<branch>` holds somebody
   * else's commits. The card needs a person (`needsPerson`), with the
   * runner's reason as its collect error; audited once per divergence.
   */
  private async divergedCollect(
    card: CardForCollect,
    message: string,
  ): Promise<CardCollectOutcome> {
    const known = card.needsPersonReason === BRANCH_DIVERGED;
    const outcome = await this.storeCollect(card, failedCollect(message), {
      needsPerson: true,
      needsPersonReason: BRANCH_DIVERGED,
    });
    if (!known) {
      await this.audit.record({
        actor: SYSTEM_ACTOR,
        action: 'card.auto_run_failed',
        target: { type: 'board_card', id: card.id },
        projectId: card.projectId,
        after: {
          number: card.number,
          reason: BRANCH_DIVERGED,
          branch: card.branch,
        },
        result: 'ok',
      });
    }
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
    this.cardChanged?.(projectId, cardId);
    for (const watcher of this.watchers) watcher(projectId, cardId);
  }

  /** #480: `board.changed` for a stack — its face, its page and its design. */
  publishStack(projectId: string, stackId: string): void {
    const data: BoardChangedData = { stackId };
    try {
      this.live.publish(`project:${projectId}`, BOARD_CHANGED_EVENT, data);
    } catch (error) {
      this.logger.warn(
        `board.changed stack ${stackId} not published: ${(error as Error).message}`,
      );
    }
  }

  /** #443: `board.changed` for every card that depends on `cardId`. */
  async publishDependants(projectId: string, cardId: string): Promise<void> {
    const rows = await this.prisma.boardCardDependency.findMany({
      where: { dependsOnId: cardId },
      select: { cardId: true },
    });
    for (const row of rows) this.publish(projectId, row.cardId);
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
