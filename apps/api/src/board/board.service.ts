import {
  type AcceptBoardCardResponse,
  BOARD_COLUMNS,
  BOARD_COMPLETED_PAGE_SIZE,
  BOARD_ERROR,
  type BoardCardDetail,
  type BoardCardKind,
  type BoardColumnView,
  type BoardSettingsView,
  type BoardView,
  CARD_SUMMARY_MAX,
  type CardMergeOutcome,
  type CardPullRequestView,
  captureFingerprint,
  cardChange,
  cardLabel,
  type FleetCardEdits,
  isActiveRoundPhase,
  type Role,
} from '@agentdock/shared';
import { roleAtLeast } from '@agentdock/shared/protocol';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { BoardCard } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { usageByRun } from '../history/run-usage';
import { mergeMethodOf } from '../planner/planner-instructions.service';
import { TextNormalizer } from '../text/text-normalizer';
import { TextOwners } from '../text/text-owners';
import { BoardCommands, boardOutput } from './board-commands';
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
  type BoardProject,
  BoardWork,
} from './board-work';
import type {
  AcceptBoardCardDto,
  CreateBoardCardDto,
  MoveBoardCardDto,
  UpdateBoardCardDto,
  UpdateBoardSettingsDto,
} from './dto';

const USER_REF = { select: { id: true, email: true } } as const;

/**
 * #244 D8: Inbox cards are content-derived, so only operators and above see
 * them (ADR-0021 §5). A role left out is the board's own read: everything.
 */
const seesInbox = (role: Role | undefined): boolean =>
  role === undefined || roleAtLeast(role, 'operator');

/**
 * #282 D4: holds the fleet's `FleetCardEdits` port. The fleet module imports
 * the board module and sets it at startup; without it, a fleet card's edit is
 * stored and no slot is told.
 */
@Injectable()
export class FleetCardEditsRef {
  private port: FleetCardEdits | null = null;

  set(port: FleetCardEdits | null): void {
    this.port = port;
  }

  get(): FleetCardEdits | null {
    return this.port;
  }
}

/** A Claude session id of a card: a uuid, so it can be looked up as one. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The project Board (issue #242 "API"): cards, their columns and order, the
 * board settings, and the person's buttons — Mark finished, Accept, Stop.
 * Starting a round is `BoardRoundsService`; the runner's and Claude's events
 * are `BoardSink`.
 */
@Injectable()
export class BoardService implements OnModuleInit {
  private readonly logger = new Logger(BoardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly work: BoardWork,
    private readonly audit: AuditService,
    private readonly commands: BoardCommands,
    private readonly text: TextNormalizer,
    private readonly textOwners: TextOwners,
    private readonly fleetEdits: FleetCardEditsRef,
  ) {}

  /** #271 D10: a card's English title carries its own fingerprint (#244 D6). */
  onModuleInit(): void {
    this.textOwners.register('board_card', {
      publish: (projectId, cardId) => this.work.publish(projectId, cardId),
      derive: async (tx, cardId, applied) => {
        const title = applied.find((f) => f.field === 'title');
        if (!title) return;
        await tx.boardCard.update({
          where: { id: cardId },
          data: { fingerprint: captureFingerprint(title.english) },
        });
      },
    });
    this.textOwners.register('board_card_round', {
      publish: async (projectId, roundId) => {
        const round = await this.prisma.boardCardRound.findUnique({
          where: { id: roundId },
          select: { cardId: true },
        });
        if (round) this.work.publish(projectId, round.cardId);
      },
    });
  }

  /**
   * #271 D4, D9: normalizes a card's changed title and body, asking for its
   * kind while the model may still set it — `auto`, no Run yet, and not a
   * captured card, whose kind a model already chose.
   */
  async normalizeCard(
    card: Pick<
      BoardCard,
      'id' | 'projectId' | 'kindSource' | 'branch' | 'source'
    >,
    fields: { title?: string; body?: string },
    actor: Pick<BoardActor, 'userId'>,
  ): Promise<void> {
    await this.text.request(
      card.projectId,
      { ownerType: 'board_card', ownerId: card.id },
      Object.entries(fields).flatMap(([field, text]) =>
        text === undefined ? [] : [{ field, text }],
      ),
      {
        classifyKind:
          card.kindSource === 'auto' &&
          card.branch === null &&
          card.source !== 'captured',
        authorId: actor.userId,
      },
    );
  }

  /**
   * `GET /board`: Completed holds the newest page, before `completedBefore`.
   * A viewer gets no Inbox column (#244 D8).
   */
  async board(
    projectId: string,
    completedBefore?: Date,
    role?: Role,
  ): Promise<BoardView> {
    const inbox = seesInbox(role);
    const include = {
      rounds: { orderBy: { round: 'desc' as const } },
      design: cardDesignSelect,
    };
    const [open, completed, settings, running] = await Promise.all([
      this.prisma.boardCard.findMany({
        where: {
          projectId,
          column: inbox
            ? { not: 'completed' }
            : { notIn: ['completed', 'inbox'] },
        },
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
    const shown = BOARD_COLUMNS.filter((column) => inbox || column !== 'inbox');
    const columns: BoardColumnView[] = shown.map((column) =>
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

  /** A viewer asking for an Inbox card finds none (#244 D8). */
  async detail(
    projectId: string,
    number: number,
    role?: Role,
  ): Promise<BoardCardDetail> {
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
    if (!card || (card.column === 'inbox' && !seesInbox(role))) {
      throw boardError(404, BOARD_ERROR.notFound, 'Card not found');
    }
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
    const trackedIds = cards
      .map((c) => c.trackedSessionId)
      .filter((id): id is string => id !== null);
    const [usage, hooked, alive] = await Promise.all([
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
      // #282 D2: alive = not ended (no stale detection for manual sessions).
      trackedIds.length === 0
        ? Promise.resolve([])
        : this.prisma.agentSession.findMany({
            where: { id: { in: trackedIds }, endedAt: null },
            select: { id: true },
          }),
    ]);
    const costs = new Map<string, string>();
    for (const [runId, u] of usage) {
      if (u.costUsd !== null) costs.set(runId, u.costUsd);
    }
    return {
      costs,
      hooked: new Set(hooked.map((s) => s.externalId)),
      alive: new Set(alive.map((s) => s.id)),
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
    const title = dto.title.trim();
    const card = await this.prisma.$transaction(async (tx) => {
      const next = await this.work.nextCard(tx, projectId);
      const position = await this.work.place(
        tx,
        { id: '', projectId },
        'todo',
        0,
      );
      return tx.boardCard.create({
        data: {
          projectId,
          ...next,
          title,
          fingerprint: captureFingerprint(title),
          body: dto.body ?? '',
          // #271 D9: without a kind the model classifies it.
          kind: dto.kind ?? 'feature',
          kindSource: dto.kind === undefined ? 'auto' : 'person',
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
    await this.normalizeCard(
      card,
      { title: card.title, body: card.body },
      actor,
    );
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
    const { continueAfterDesign, autoCollect, ...fields } = dto;
    // #282 D3: Automatic work is a terminal card's; refused before anything is written.
    if (autoCollect !== undefined && card.source !== 'terminal') {
      throw boardError(
        422,
        BOARD_ERROR.notTracked,
        'Automatic work is set on a card tracked from a terminal session only',
      );
    }
    if (continueAfterDesign !== undefined) {
      await this.toggleContinue(card, continueAfterDesign, actor);
    }
    if (autoCollect !== undefined) {
      await this.toggleAutoCollect(card, autoCollect, actor);
    }
    // A switch alone is its own audit record, not a card edit.
    if (
      (continueAfterDesign !== undefined || autoCollect !== undefined) &&
      Object.values(fields).every((v) => v === undefined)
    ) {
      this.work.publish(projectId, card.id);
      return this.detail(projectId, number);
    }
    const data = {
      ...(fields.title !== undefined ? { title: fields.title.trim() } : {}),
      ...(fields.body !== undefined ? { body: fields.body } : {}),
      ...(fields.kind !== undefined ? { kind: fields.kind } : {}),
      // #271 D9: a kind the person sets is theirs from now on.
      ...(fields.kind !== undefined ? { kindSource: 'person' as const } : {}),
      ...(fields.issueOnRun !== undefined
        ? { issueOnRun: fields.issueOnRun }
        : {}),
      ...(fields.specOnRun !== undefined
        ? { specOnRun: fields.specOnRun }
        : {}),
      ...(fields.model !== undefined ? { model: fields.model } : {}),
    };
    await this.prisma.boardCard.update({
      where: { id: card.id },
      data: {
        ...data,
        // #244 D6: every card carries its title's fingerprint.
        ...(data.title !== undefined
          ? { fingerprint: captureFingerprint(data.title) }
          : {}),
      },
    });
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
    // #271 D8: only what changed; editing the English text is a save too.
    const changed = {
      ...(data.title !== undefined && data.title !== card.title
        ? { title: data.title }
        : {}),
      ...(data.body !== undefined && data.body !== card.body
        ? { body: data.body }
        : {}),
    };
    if (Object.keys(changed).length > 0) {
      await this.normalizeCard(
        {
          ...card,
          kindSource: data.kindSource ?? card.kindSource,
        },
        changed,
        actor,
      );
    }
    if (card.source === 'fleet') await this.fleetEdited(card, data);
    return this.detail(projectId, number);
  }

  /** #282 D4: a stored text edit of a `fleet` card reaches its running slot. */
  private async fleetEdited(
    card: CardWithRounds,
    data: { title?: string; body?: string; kind?: BoardCardKind },
  ): Promise<void> {
    const change = cardChange(
      { title: card.title, body: card.body, kind: card.kind },
      {
        title: data.title ?? card.title,
        body: data.body ?? card.body,
        kind: data.kind ?? card.kind,
      },
    );
    const port = this.fleetEdits.get();
    if (!change || !port) return;
    try {
      // TODO(i309-contract): pass `editor: { userId, email }` once
      // `FleetCardEdit` carries it.
      await port.cardEdited({
        projectId: card.projectId,
        cardId: card.id,
        number: card.number,
        label: cardLabel(card.number),
        change,
      });
    } catch (error) {
      // The edit is stored either way (the port's contract).
      this.logger.warn(
        `fleet edit of ${cardLabel(card.number)} not delivered: ${(error as Error).message}`,
      );
    }
  }

  /** #282 D3: Automatic work — collect when the tracked session finishes. */
  private async toggleAutoCollect(
    card: CardWithRounds,
    on: boolean,
    actor: BoardActor,
  ): Promise<void> {
    if (card.autoCollect === on) return;
    await this.prisma.boardCard.update({
      where: { id: card.id },
      data: { autoCollect: on },
    });
    await this.audit.record({
      ...actor.ctx,
      action: 'card.updated',
      target: { type: 'board_card', id: card.id },
      projectId: card.projectId,
      before: { number: card.number, autoCollect: !on },
      after: { number: card.number, autoCollect: on },
      result: 'ok',
    });
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

  /**
   * `POST …/accept` (D10): Finished → Completed. With `merge` (#273 D13,
   * ADR-0029), the card's PR is merged first through the runner's `gh`,
   * bound to the head the person saw; a refused merge leaves the card in
   * Finished. Without it, the move only (D14).
   */
  async accept(
    projectId: string,
    number: number,
    dto: AcceptBoardCardDto,
    actor: BoardActor,
  ): Promise<AcceptBoardCardResponse> {
    const project = await this.work.project(projectId);
    const card = await this.work.card(projectId, number);
    if (card.column !== 'finished') {
      throw boardError(
        409,
        BOARD_ERROR.wrongColumn,
        'Only a card in Finished is accepted',
      );
    }
    // #282 D4: a fleet card's PR is the orchestrator's to merge, never Accept's.
    const merge =
      dto.merge && card.source !== 'fleet'
        ? await this.merge(project, card, dto.merge.headSha, actor)
        : null;
    await this.work.move(
      project,
      card,
      { to: 'completed', index: 0, source: 'person' },
      actor,
    );
    return { ...(await this.detail(projectId, number)), merge };
  }

  /** #273 D13: `card.merge`, audited; a refusal is 409 `merge_failed`. */
  private async merge(
    project: BoardProject,
    card: CardWithRounds,
    headSha: string,
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
          comment: `Completed as ${cardLabel(card.number)} on the AgentDock board; merged in #${pr}.`,
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
      },
      result: 'ok',
    });
    return {
      merged: true,
      alreadyMerged: output.alreadyMerged,
      method: output.method,
      mergeCommit: output.mergeCommit,
      issueClosed: output.issueClosed,
      ...(output.issueError !== undefined
        ? { issueError: output.issueError }
        : {}),
    };
  }

  /**
   * `GET …/pull-request` (#273 D10, operator): the card's PR as `pr.inspect`
   * reads it on the runner, and how Accept would merge it.
   */
  async pullRequest(
    projectId: string,
    number: number,
    actor: BoardActor,
  ): Promise<CardPullRequestView> {
    const project = await this.work.project(projectId);
    const card = await this.work.card(projectId, number);
    if (card.prNumber === null) {
      throw boardError(
        404,
        BOARD_ERROR.noPullRequest,
        `${cardLabel(card.number)} has no pull request`,
      );
    }
    const pr = boardOutput(
      'pr.inspect',
      await this.commands.inspectPr(
        project.runnerId,
        { projectId: project.id, root: project.rootPath, pr: card.prNumber },
        { role: actor.role, ctx: actor.ctx },
      ),
    );
    return {
      number: pr.number,
      url: pr.url,
      state: pr.state,
      headSha: pr.headSha,
      mergeable: pr.mergeable,
      mergeStateStatus: pr.mergeStateStatus,
      checks: pr.checks,
      method: mergeMethodOf(project.codeSentinelConfig),
      canMerge:
        pr.state === 'open' &&
        this.commands.serves(project.runnerId, 'card.merge'),
    };
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
    if (dto.captureEnabled === true && !before.captureEnabled) {
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { shipSessionContent: true },
      });
      // #244 D10: capture reads content, so it needs content shipped.
      if (!project?.shipSessionContent) {
        throw boardError(
          422,
          BOARD_ERROR.captureNeedsContent,
          'Turn on session content for the project before capture',
        );
      }
    }
    const data = {
      issueOnRun: dto.issueOnRun,
      specOnRun: dto.specOnRun,
      maxRunning: dto.maxRunning,
      ...(dto.captureEnabled !== undefined
        ? { captureEnabled: dto.captureEnabled }
        : {}),
      ...(dto.captureModel !== undefined
        ? { captureModel: dto.captureModel }
        : {}),
      ...(dto.autoCollectTracked !== undefined
        ? { autoCollectTracked: dto.autoCollectTracked }
        : {}),
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
        captureEnabled: before.captureEnabled,
        captureModel: before.captureModel,
        autoCollectTracked: before.autoCollectTracked,
      },
      after: {
        issueOnRun: row.issueOnRun,
        specOnRun: row.specOnRun,
        maxRunning: row.maxRunning,
        captureEnabled: row.captureEnabled,
        captureModel: row.captureModel,
        autoCollectTracked: row.autoCollectTracked,
      },
      result: 'ok',
    });
    return toSettingsView(projectId, row);
  }
}
