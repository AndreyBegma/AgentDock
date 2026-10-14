import {
  ACTIVE_CARD_ROUND_PHASES,
  BOARD_CHANGED_EVENT,
  BOARD_ERROR,
  type BoardChangedData,
  type BoardColumn,
  type BoardMoveDecision,
  type BoardMoveEffect,
  type BoardMoveSource,
  boardMoveRule,
  CARD_FINISHED_EVENT,
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
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, RunStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { type AuditContext, SYSTEM_ACTOR } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { LiveService } from '../live/live.service';
import { projectNotFound } from '../projects';
import { recordServerEvent } from '../server-events/server-events';
import { BoardCommands, boardOutput } from './board-commands';
import { BoardFailure, boardError, cardNotFound } from './board-error';
import type { CardWithRounds } from './board-mapper';

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
}

export const ACTIVE_PHASES = [...ACTIVE_CARD_ROUND_PHASES];

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
}

const refusalOf = (
  decision: Extract<BoardMoveDecision, { allowed: false }>,
): BoardFailure =>
  decision.error === 'card_running'
    ? boardError(
        409,
        BOARD_ERROR.cardRunning,
        'The worker is running: stop it first, or move the card to Finished',
      )
    : boardError(
        409,
        BOARD_ERROR.moveRefused,
        decision.error === 'automatic_to_completed'
          ? 'Only a person completes a card'
          : 'A completed card is moved only by a person',
        { reason: decision.error },
      );

/**
 * The board's shared moves and side effects (issue #242 D7, D8, D10): column
 * moves under `boardMoveRule`, round endings, `card.collect` and `card.close`
 * in the background, the `card.finished` server event, live updates. The
 * controller's services, the round service and the sink all move cards
 * through here, so a rule is enforced in one place.
 */
@Injectable()
export class BoardWork {
  private readonly logger = new Logger(BoardWork.name);
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: BoardCommands,
    private readonly live: LiveService,
    private readonly audit: AuditService,
  ) {}

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

  /** D8, in the background: the runner's push can take up to 180 s. */
  collect(cardId: string): void {
    this.track(
      this.collectNow(cardId).catch((error: unknown) => {
        this.logger.error(
          `card.collect of ${cardId} failed`,
          error instanceof Error ? error.stack : String(error),
        );
      }),
    );
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
   * D8: commit leftovers, push, open a PR once; store it. Then D15's
   * `card.finished`, once per round, naming the PR when there is one.
   */
  private async collectNow(cardId: string): Promise<void> {
    const card = await this.prisma.boardCard.findUnique({
      where: { id: cardId },
      include: { rounds: { orderBy: { round: 'desc' } } },
    });
    if (!card || card.branch === null) return;
    const project = await this.project(card.projectId);
    const round = card.rounds[0] ?? null;
    let pr = { prNumber: card.prNumber, prUrl: card.prUrl };
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
            branch: card.branch,
            number: card.number,
            title: `${cardLabel(card.number)}: ${card.title}`.slice(0, 256),
            body: cardPullRequestBody({
              number: card.number,
              summary,
              issueNumber: card.issueNumber,
            }),
          },
          { role: 'operator', ctx: { actor: SYSTEM_ACTOR } },
        ),
      );
      if (output.prNumber !== undefined && output.prUrl !== undefined) {
        pr = { prNumber: output.prNumber, prUrl: output.prUrl };
        await this.prisma.boardCard.update({
          where: { id: card.id },
          data: pr,
        });
        this.publish(project.id, card.id);
      }
    } catch (error) {
      this.logger.warn(
        `card.collect of ${cardLabel(card.number)} failed: ${(error as Error).message}`,
      );
    }
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
