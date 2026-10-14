import { randomInt } from 'node:crypto';
import {
  BOARD_COLUMNS,
  BOARD_COMPLETED_PAGE_SIZE,
  BOARD_ERROR,
  type BoardCardDetail,
  type BoardColumnView,
  type BoardSettingsView,
  type BoardView,
  CARD_SUMMARY_MAX,
  isActiveRoundPhase,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { usageByRun } from '../history/run-usage';
import { boardError } from './board-error';
import {
  type CardFacts,
  type CardWithRounds,
  cardDesignSelect,
  toCardDetail,
  toCardView,
  toSettingsView,
} from './board-mapper';
import {
  ACTIVE_PHASES,
  BOARD_SYSTEM_ACTOR,
  type BoardActor,
  BoardWork,
} from './board-work';
import type {
  CreateBoardCardDto,
  MoveBoardCardDto,
  UpdateBoardCardDto,
  UpdateBoardSettingsDto,
} from './dto';

const SHORT_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const USER_REF = { select: { id: true, email: true } } as const;

/** D5: the 8-character id of a card's worktree, tmux session and runner record. */
const newShortId = (): string =>
  Array.from(
    { length: 8 },
    () => SHORT_ID_ALPHABET[randomInt(SHORT_ID_ALPHABET.length)],
  ).join('');

/** A Claude session id of a card: a uuid, so it can be looked up as one. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The project Board (issue #242 "API"): cards, their columns and order, the
 * board settings, and the person's buttons — Mark finished, Accept, Stop.
 * Starting a round is `BoardRoundsService`; the runner's and Claude's events
 * are `BoardSink`.
 */
@Injectable()
export class BoardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly work: BoardWork,
    private readonly audit: AuditService,
  ) {}

  /** `GET /board`: Completed holds the newest page, before `completedBefore`. */
  async board(projectId: string, completedBefore?: Date): Promise<BoardView> {
    const include = {
      rounds: { orderBy: { round: 'desc' as const } },
      design: cardDesignSelect,
    };
    const [open, completed, settings, running] = await Promise.all([
      this.prisma.boardCard.findMany({
        where: { projectId, column: { not: 'completed' } },
        include,
        orderBy: [{ position: 'asc' }, { number: 'asc' }],
      }),
      this.prisma.boardCard.findMany({
        where: {
          projectId,
          column: 'completed',
          ...(completedBefore ? { completedAt: { lt: completedBefore } } : {}),
        },
        include,
        orderBy: [{ completedAt: 'desc' }, { number: 'desc' }],
        take: BOARD_COMPLETED_PAGE_SIZE + 1,
      }),
      this.prisma.boardSettings.findUnique({ where: { projectId } }),
      this.running(projectId),
    ]);
    const page = completed.slice(0, BOARD_COMPLETED_PAGE_SIZE);
    const facts = await this.facts([...open, ...page]);
    const columns: BoardColumnView[] = BOARD_COLUMNS.map((column) =>
      column === 'completed'
        ? {
            column,
            cards: page.map((c) => toCardView(c, facts)),
            hasMore: completed.length > BOARD_COMPLETED_PAGE_SIZE,
          }
        : {
            column,
            cards: open
              .filter((c) => c.column === column)
              .map((c) => toCardView(c, facts)),
            hasMore: false,
          },
    );
    return {
      projectId,
      columns,
      running,
      settings: toSettingsView(projectId, settings),
    };
  }

  async detail(projectId: string, number: number): Promise<BoardCardDetail> {
    const card = await this.prisma.boardCard.findUnique({
      where: { projectId_number: { projectId, number } },
      include: {
        createdBy: USER_REF,
        movedBy: USER_REF,
        completedBy: USER_REF,
        rounds: {
          orderBy: { round: 'desc' },
          include: { author: USER_REF },
        },
        design: cardDesignSelect,
      },
    });
    if (!card) throw boardError(404, BOARD_ERROR.notFound, 'Card not found');
    return toCardDetail(card, await this.facts([card]));
  }

  /** Active rounds of the project now (D13). */
  running(projectId: string): Promise<number> {
    return this.prisma.boardCardRound.count({
      where: { phase: { in: ACTIVE_PHASES }, card: { projectId } },
    });
  }

  /** Round costs (#21 usage by run) and which card sessions hooks reached. */
  private async facts(cards: CardWithRounds[]): Promise<CardFacts> {
    const runIds = cards.flatMap((c) => c.rounds.map((r) => r.runId));
    const sessionIds = cards
      .map((c) => c.sessionId)
      .filter((id): id is string => id !== null);
    const [usage, hooked] = await Promise.all([
      usageByRun(this.prisma, runIds),
      sessionIds.length === 0
        ? Promise.resolve([])
        : this.prisma.agentSession.findMany({
            where: {
              runtime: 'claude',
              origin: 'run',
              externalId: { in: sessionIds },
            },
            select: { externalId: true },
          }),
    ]);
    const costs = new Map<string, string>();
    for (const [runId, u] of usage) {
      if (u.costUsd !== null) costs.set(runId, u.costUsd);
    }
    return {
      costs,
      hooked: new Set(hooked.map((s) => s.externalId)),
      now: new Date(),
    };
  }

  /**
   * `POST /board/cards`: the top of To Do. The number is the project's next
   * under an advisory lock, so concurrent creates never collide (D1).
   */
  async create(
    projectId: string,
    dto: CreateBoardCardDto,
    actor: BoardActor,
  ): Promise<BoardCardDetail> {
    const settings = toSettingsView(
      projectId,
      await this.prisma.boardSettings.findUnique({ where: { projectId } }),
    );
    const now = new Date();
    const card = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`board-number:${projectId}`}))`;
      const last = await tx.boardCard.aggregate({
        where: { projectId },
        _max: { number: true },
      });
      const position = await this.work.place(
        tx,
        { id: '', projectId },
        'todo',
        0,
      );
      return tx.boardCard.create({
        data: {
          projectId,
          number: (last._max.number ?? 0) + 1,
          shortId: newShortId(),
          title: dto.title.trim(),
          body: dto.body ?? '',
          kind: dto.kind ?? 'feature',
          column: 'todo',
          position,
          issueOnRun: dto.issueOnRun ?? settings.issueOnRun,
          specOnRun: dto.specOnRun ?? settings.specOnRun,
          createdById: actor.userId,
          movedById: actor.userId,
          movedAt: now,
        },
      });
    });
    await this.audit.record({
      ...actor.ctx,
      action: 'card.created',
      target: { type: 'board_card', id: card.id },
      projectId,
      after: {
        number: card.number,
        title: card.title,
        kind: card.kind,
        issueOnRun: card.issueOnRun,
        specOnRun: card.specOnRun,
      },
      result: 'ok',
    });
    this.work.publish(projectId, card.id);
    return this.detail(projectId, card.number);
  }

  /** `PATCH /board/cards/:number`: applies from the next round. */
  async update(
    projectId: string,
    number: number,
    dto: UpdateBoardCardDto,
    actor: BoardActor,
  ): Promise<BoardCardDetail> {
    const card = await this.work.card(projectId, number);
    const { continueAfterDesign, ...fields } = dto;
    if (continueAfterDesign !== undefined) {
      await this.toggleContinue(card, continueAfterDesign, actor);
      // The switch alone is its own audit record, not a card edit.
      if (Object.values(fields).every((v) => v === undefined)) {
        this.work.publish(projectId, card.id);
        return this.detail(projectId, number);
      }
    }
    const data = {
      ...(fields.title !== undefined ? { title: fields.title.trim() } : {}),
      ...(fields.body !== undefined ? { body: fields.body } : {}),
      ...(fields.kind !== undefined ? { kind: fields.kind } : {}),
      ...(fields.issueOnRun !== undefined
        ? { issueOnRun: fields.issueOnRun }
        : {}),
      ...(fields.specOnRun !== undefined
        ? { specOnRun: fields.specOnRun }
        : {}),
      ...(fields.model !== undefined ? { model: fields.model } : {}),
    };
    await this.prisma.boardCard.update({ where: { id: card.id }, data });
    const before = Object.fromEntries(
      Object.keys(data).map((k) => [k, card[k as keyof typeof data]]),
    );
    await this.audit.record({
      ...actor.ctx,
      action: 'card.updated',
      target: { type: 'board_card', id: card.id },
      projectId,
      before,
      after: { number, ...data },
      result: 'ok',
    });
    this.work.publish(projectId, card.id);
    return this.detail(projectId, number);
  }

  /**
   * #243 D5: "Continue after design" — approving the design starts round 1.
   * It is the person's until the design is approved; after that the approval
   * already did, or did not, start the worker.
   */
  private async toggleContinue(
    card: CardWithRounds,
    on: boolean,
    actor: BoardActor,
  ): Promise<void> {
    if (card.continueAfterDesign === on) return;
    const design = await this.prisma.taskDesign.findUnique({
      where: { cardId: card.id },
      select: { status: true },
    });
    if (design?.status === 'approved') {
      throw boardError(
        409,
        BOARD_ERROR.designApproved,
        'The design is approved; "Continue after design" no longer changes',
      );
    }
    await this.prisma.boardCard.update({
      where: { id: card.id },
      data: { continueAfterDesign: on },
    });
    await this.audit.record({
      ...actor.ctx,
      action: 'card.design_continue_toggled',
      target: { type: 'board_card', id: card.id },
      projectId: card.projectId,
      before: { number: card.number, continueAfterDesign: !on },
      after: { number: card.number, continueAfterDesign: on },
      result: 'ok',
    });
  }

  /** 409 `card_running` while a round is active; the worktree goes with it. */
  async delete(
    projectId: string,
    number: number,
    actor: BoardActor,
  ): Promise<void> {
    const card = await this.work.card(projectId, number);
    if (isActiveRoundPhase(card.rounds[0]?.phase)) {
      throw boardError(
        409,
        BOARD_ERROR.cardRunning,
        'The worker is running: stop it before deleting the card',
      );
    }
    const designed = await this.prisma.$transaction(async (tx) => {
      const fresh = await this.work.lock(tx, card.id);
      if (isActiveRoundPhase(fresh.rounds[0]?.phase)) {
        throw boardError(
          409,
          BOARD_ERROR.cardRunning,
          'The worker is running: stop it before deleting the card',
        );
      }
      // #243 D2: whether the runner holds a design worktree for the card.
      const turns = await tx.planTurn.count({ where: { cardId: card.id } });
      await tx.boardCard.delete({ where: { id: card.id } });
      return turns > 0;
    });
    await this.audit.record({
      ...actor.ctx,
      action: 'card.deleted',
      target: { type: 'board_card', id: card.id },
      projectId,
      before: { number: card.number, title: card.title, column: card.column },
      result: 'ok',
    });
    this.work.publish(projectId, card.id);
    if (card.branch !== null || designed) {
      const project = await this.work.project(projectId);
      if (card.branch !== null) this.work.close(project, card.id, actor);
      if (designed) this.work.closeDesign(project, card.id, actor);
    }
  }

  /** `POST …/move` (D7). */
  async move(
    projectId: string,
    number: number,
    dto: MoveBoardCardDto,
    actor: BoardActor,
  ): Promise<BoardCardDetail> {
    const project = await this.work.project(projectId);
    const card = await this.work.card(projectId, number);
    await this.work.move(
      project,
      card,
      {
        to: dto.column,
        index: dto.index,
        source: 'person',
        stopWorker: dto.stopWorker,
      },
      actor,
    );
    return this.detail(projectId, number);
  }

  /** `POST …/finish`: Mark finished — the active round, by the person. */
  async finish(
    projectId: string,
    number: number,
    actor: BoardActor,
  ): Promise<BoardCardDetail> {
    const project = await this.work.project(projectId);
    const card = await this.work.card(projectId, number);
    if (!isActiveRoundPhase(card.rounds[0]?.phase)) {
      throw boardError(409, BOARD_ERROR.notRunning, 'No worker is running');
    }
    await this.work.move(
      project,
      card,
      { to: 'finished', index: 0, source: 'person', finishedBy: 'person' },
      actor,
    );
    return this.detail(projectId, number);
  }

  /** `POST …/accept` (D10): Finished → Completed. */
  async accept(
    projectId: string,
    number: number,
    actor: BoardActor,
  ): Promise<BoardCardDetail> {
    const project = await this.work.project(projectId);
    const card = await this.work.card(projectId, number);
    if (card.column !== 'finished') {
      throw boardError(
        409,
        BOARD_ERROR.wrongColumn,
        'Only a card in Finished is accepted',
      );
    }
    await this.work.move(
      project,
      card,
      { to: 'completed', index: 0, source: 'person' },
      actor,
    );
    return this.detail(projectId, number);
  }

  /** `POST …/stop`: kill the worker; the round is `cancelled`. */
  async stop(
    projectId: string,
    number: number,
    actor: BoardActor,
  ): Promise<BoardCardDetail> {
    const project = await this.work.project(projectId);
    const card = await this.work.card(projectId, number);
    await this.work.stop(project, card, actor);
    return this.detail(projectId, number);
  }

  /**
   * `card.finish` (D6): the worker's `finish_card`. The card is the one whose
   * Claude session asks — `session.id` — in the asking runner's project; any
   * other session is `null`. A round already finished stays finished.
   */
  async finishByWorker(
    project: { id: string; runnerId: string },
    sessionId: string,
    summary: string,
  ): Promise<{ number: number } | null> {
    if (!UUID.test(sessionId)) return null;
    const card = await this.prisma.boardCard.findFirst({
      where: {
        projectId: project.id,
        sessionId,
        project: { runnerId: project.runnerId },
      },
      include: { rounds: { orderBy: { round: 'desc' } } },
    });
    if (!card) return null;
    const round = card.rounds[0];
    if (round && isActiveRoundPhase(round.phase)) {
      const target = await this.work.project(project.id);
      await this.work.move(
        target,
        card,
        {
          to: 'finished',
          index: 0,
          source: 'automatic',
          finishedBy: 'worker',
          summary: summary.slice(0, CARD_SUMMARY_MAX),
        },
        BOARD_SYSTEM_ACTOR,
      );
    }
    return { number: card.number };
  }

  async settings(projectId: string): Promise<BoardSettingsView> {
    return toSettingsView(
      projectId,
      await this.prisma.boardSettings.findUnique({ where: { projectId } }),
    );
  }

  /** `PUT /board-settings` (project admin). */
  async updateSettings(
    projectId: string,
    dto: UpdateBoardSettingsDto,
    actor: BoardActor,
  ): Promise<BoardSettingsView> {
    const before = await this.settings(projectId);
    const data = {
      issueOnRun: dto.issueOnRun,
      specOnRun: dto.specOnRun,
      maxRunning: dto.maxRunning,
      updatedById: actor.userId,
    };
    const row = await this.prisma.boardSettings.upsert({
      where: { projectId },
      create: { projectId, ...data },
      update: data,
    });
    await this.audit.record({
      ...actor.ctx,
      action: 'board.settings_updated',
      target: { type: 'project', id: projectId },
      projectId,
      before: {
        issueOnRun: before.issueOnRun,
        specOnRun: before.specOnRun,
        maxRunning: before.maxRunning,
      },
      after: {
        issueOnRun: row.issueOnRun,
        specOnRun: row.specOnRun,
        maxRunning: row.maxRunning,
      },
      result: 'ok',
    });
    return toSettingsView(projectId, row);
  }
}
