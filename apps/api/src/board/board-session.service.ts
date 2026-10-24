import {
  BOARD_ERROR,
  type BoardCardView,
  type BoardColumn,
  type BoardStackDetail,
  type BoardStackView,
  captureFingerprint,
  cardLabel,
  isActiveRoundPhase,
  type Role,
  type TaskDesignSummary,
} from '@nautelle/shared';
import {
  LOCAL_BOARD_CARD_ROUNDS_MAX,
  LOCAL_BOARD_LIST_COMPLETED_MAX,
  type LocalBoardListCard,
  type LocalDesignBrief,
  type LocalMethodArgs,
  type LocalMethodResult,
  type LocalStack,
} from '@nautelle/shared/protocol';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { BoardCard } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { BoardService } from './board.service';
import { boardError } from './board-error';
import {
  BoardTerminalService,
  type ManualSession,
} from './board-terminal.service';
import { type BoardActor, BoardWork } from './board-work';

/** The asking runner's project, as the local router verified it. */
export interface SessionBoardProject {
  id: string;
  runnerId: string;
  /** `owner/name` — a taken card's pull request must be one of its. */
  repo: string;
}

/** A refusal of a session's board tool that is no Board error (#845). */
export class BoardSessionRefusal extends Error {
  constructor(
    readonly code: 'card_taken' | 'not_taken' | 'completed_needs_person',
    message: string,
  ) {
    super(message);
  }
}

type TakenCard = NonNullable<LocalMethodResult<'card.release'>['next']>;
type TakeResult = LocalMethodResult<'card.take'>;

/** Board order: column by column, then the place in the column. */
const BOARD_ORDER = [
  { column: 'asc' as const },
  { position: 'asc' as const },
  { number: 'asc' as const },
];

const PULL_REQUEST =
  /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d{1,9})\/?$/;

/** One card as the board tools list it. */
export const localListCardOf = (card: BoardCardView): LocalBoardListCard => {
  const phase = card.round?.phase ?? null;
  return {
    number: card.number,
    label: card.label,
    title: card.title,
    kind: card.kind,
    column: card.column,
    roundPhase: phase,
    running: isActiveRoundPhase(phase),
    waitingOnQuestion: Boolean(card.round?.pendingQuestion),
    prNumber: card.prNumber,
    prUrl: card.prUrl,
    prState: card.prState,
    ciState: card.ciState,
    mergedAt: card.mergedAt,
    needsPerson: card.needsPerson,
    dependsOn: (card.dependsOn ?? []).map((d) => d.number),
    taken: card.taken ?? null,
    queuedForSessionId: card.queuedForSessionId ?? null,
  };
};

/** C-377: a design as the stack and design tools brief it. */
export const localDesignBriefOf = (
  design: TaskDesignSummary,
): LocalDesignBrief => ({
  needed: design.needed,
  status: design.status,
  variantCount: design.variantCount,
  approvedRevisionId: design.approvedRevisionId,
  busy:
    design.busySince !== null ||
    design.status === 'generating' ||
    design.status === 'revising',
});

/**
 * C-377: one stack as `board.list` and the stack methods answer it — its
 * stages with their cards by number.
 */
export const localStackOf = (
  stack: BoardStackView | BoardStackDetail,
): LocalStack => ({
  number: stack.number,
  label: stack.label,
  title: stack.title,
  column: stack.column,
  accepted: stack.accepted,
  total: stack.total,
  currentStage: stack.currentStage,
  stages: stack.stages.map((s) => ({
    position: s.position,
    title: s.title,
    cards: s.cards.map((c) => (typeof c === 'number' ? c : c.number)),
  })),
  design: stack.design ? localDesignBriefOf(stack.design) : null,
  run: stack.run
    ? {
        state: stack.run.state,
        queued: stack.run.queued,
        waiting: stack.run.waiting,
        running: stack.run.running,
        pause: stack.run.pause
          ? {
              code: stack.run.pause.code,
              message: stack.run.pause.message,
              card: stack.run.pause.card,
            }
          : null,
      }
    : null,
});

const takenCardOf = (
  card: Pick<BoardCard, 'number' | 'title' | 'body' | 'kind' | 'takenBranch'>,
): TakenCard => ({
  number: card.number,
  label: cardLabel(card.number),
  title: card.title,
  body: card.body,
  kind: card.kind,
  branch: card.takenBranch,
});

/**
 * A person's own session works the Board (#845, ADR-0083): the reads of the
 * board tools and the cards a session takes itself (D1, D2, D10). Control
 * goes through the Board's own services, so every rule and refusal is the
 * web app's.
 */
@Injectable()
export class BoardSessionService {
  private readonly logger = new Logger(BoardSessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly work: BoardWork,
    private readonly board: BoardService,
    private readonly terminal: BoardTerminalService,
    private readonly audit: AuditService,
  ) {}

  /** `board.list`: board order; Completed newest first, at most 20. */
  async list(
    projectId: string,
    role: Role,
    column: BoardColumn | undefined,
  ): Promise<LocalMethodResult<'board.list'>> {
    const view = await this.board.board(projectId, undefined, role);
    const cards = view.columns
      .filter((c) => column === undefined || c.column === column)
      .flatMap((c) =>
        c.column === 'completed'
          ? c.cards.slice(0, LOCAL_BOARD_LIST_COMPLETED_MAX)
          : c.cards,
      )
      .map(localListCardOf);
    // C-377: the stacks, with a column those whose collapsed face sits in it.
    const stacks = (view.stacks ?? [])
      .filter((s) => column === undefined || s.column === column)
      .map(localStackOf);
    return {
      settings: {
        maxRunning: view.settings.maxRunning,
        running: view.running,
        cardMergePolicy: view.settings.cardMergePolicy,
      },
      cards,
      stacks,
    };
  }

  /** `board.card`: one card in full; a viewer finds no Inbox card. */
  async card(
    projectId: string,
    number: number,
    role: Role,
  ): Promise<LocalMethodResult<'board.card'>> {
    const detail = await this.board.detail(projectId, number, role);
    return {
      ...localListCardOf(detail),
      body: detail.body,
      branch: detail.branch,
      issueUrl: detail.issueUrl,
      dependencies: (detail.dependsOn ?? []).map((d) => ({
        number: d.number,
        label: d.label,
        column: d.column,
      })),
      rounds: detail.rounds.slice(0, LOCAL_BOARD_CARD_ROUNDS_MAX).map((r) => ({
        round: r.round,
        trigger: r.trigger,
        phase: r.phase,
        summary: r.summary,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
      })),
      ciChecks: detail.ciChecks.map((c) => ({ name: c.name, link: c.link })),
      question: detail.round?.pendingQuestion ?? null,
    };
  }

  /**
   * `card.create` (D6): on the person's request the top of To Do, as the
   * web's create; a `candidate` the session proposes on its own goes to the
   * Inbox for a person to accept (ADR-0058).
   */
  async create(
    projectId: string,
    session: ManualSession,
    args: LocalMethodArgs<'card.create'>,
    actor: BoardActor,
  ): Promise<LocalMethodResult<'card.create'>> {
    if (args.candidate !== true) {
      const card = await this.board.create(
        projectId,
        { title: args.title, body: args.body, kind: args.kind },
        actor,
      );
      return { ...this.terminal.refOf(projectId, card.number), column: 'todo' };
    }
    const settings = await this.board.settings(projectId);
    const title = args.title.trim();
    const now = new Date();
    const card = await this.prisma.$transaction(async (tx) => {
      const next = await this.work.nextCard(tx, projectId);
      const position = await this.work.place(
        tx,
        { id: '', projectId },
        'inbox',
        0,
      );
      return tx.boardCard.create({
        data: {
          projectId,
          ...next,
          title,
          fingerprint: captureFingerprint(title),
          body: args.body ?? '',
          kind: args.kind ?? 'feature',
          kindSource: args.kind === undefined ? 'auto' : 'person',
          column: 'inbox',
          position,
          sourceSessionId: session.id,
          issueOnRun: args.kind === 'bug',
          specOnRun: settings.specOnRun,
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
        column: 'inbox',
        candidate: true,
        sessionId: session.id,
      },
      result: 'ok',
    });
    this.work.publish(projectId, card.id);
    await this.board.normalizeCard(
      card,
      { title: card.title, body: card.body },
      actor,
    );
    return { ...this.terminal.refOf(projectId, card.number), column: 'inbox' };
  }

  /**
   * `card.take` (D1, D2, D10): a To Do card — or an In progress one whose
   * taking session ended — is bound to the session and moves to In
   * progress. A session that already holds a card (its tracked terminal card
   * too: one per session) queues this one instead. One project's takes are
   * serialized, so two sessions never bind the same card.
   */
  async take(
    project: SessionBoardProject,
    session: ManualSession,
    number: number,
    actor: BoardActor,
  ): Promise<TakeResult> {
    const decided = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, project.id);
      const card = await this.work.card(project.id, number, tx);
      const label = cardLabel(card.number);
      if (card.trackedSessionId === session.id) {
        return { state: 'held' as const, card };
      }
      if (isActiveRoundPhase(card.rounds[0]?.phase)) {
        throw new BoardSessionRefusal(
          'card_taken',
          `${label} has an active Board Run round`,
        );
      }
      const holder = card.trackedSessionId;
      if (holder !== null) {
        if (card.source === 'terminal' || (await this.alive(tx, holder))) {
          throw new BoardSessionRefusal(
            'card_taken',
            `${label} is held by another live session`,
          );
        }
      }
      if (
        card.column !== 'todo' &&
        !(card.column === 'in_progress' && holder !== null)
      ) {
        throw boardError(
          409,
          BOARD_ERROR.wrongColumn,
          `Only a To Do card, or an In progress one whose session ended, is taken; ${label} is in ${card.column}`,
        );
      }
      const queuedFor = card.queuedForSessionId;
      if (
        queuedFor !== null &&
        queuedFor !== session.id &&
        (await this.alive(tx, queuedFor))
      ) {
        throw new BoardSessionRefusal(
          'card_taken',
          `${label} is queued for another live session`,
        );
      }
      const held = await tx.boardCard.findUnique({
        where: { trackedSessionId: session.id },
        select: { id: true },
      });
      if (held) {
        await tx.boardCard.update({
          where: { id: card.id },
          data: { queuedForSessionId: session.id },
        });
        return { state: 'queued' as const, card };
      }
      await tx.boardCard.update({
        where: { id: card.id },
        data: {
          trackedSessionId: session.id,
          queuedForSessionId: null,
          // D10: a branch a previous session left is the one to continue.
          takenBranch: card.takenBranch ?? session.gitBranch,
        },
      });
      return { state: 'bound' as const, card, holder };
    });
    const { card } = decided;
    if (decided.state === 'bound' && card.column === 'todo') {
      try {
        const target = await this.work.project(project.id);
        await this.work.move(
          target,
          card,
          { to: 'in_progress', index: 0, source: 'person' },
          actor,
        );
      } catch (error) {
        await this.prisma.boardCard.updateMany({
          where: { id: card.id, trackedSessionId: session.id },
          data: { trackedSessionId: decided.holder },
        });
        throw error;
      }
    }
    if (decided.state !== 'held') {
      await this.record(actor, project.id, card, {
        [decided.state === 'queued' ? 'queuedFor' : 'takenBy']: session.id,
      });
      this.work.publish(project.id, card.id);
    }
    const base = takenCardOf(card);
    if (decided.state !== 'queued') {
      return { ...base, state: 'taken', queuePosition: null };
    }
    const queue = await this.prisma.boardCard.findMany({
      where: { projectId: project.id, queuedForSessionId: session.id },
      orderBy: BOARD_ORDER,
      select: { id: true },
    });
    const at = queue.findIndex((q) => q.id === card.id);
    return { ...base, state: 'queued', queuePosition: at + 1 };
  }

  /**
   * `card.release` (D10): the card goes back to To Do, its binding or queue
   * marker cleared. Releasing the held card takes the next queued one.
   */
  async release(
    project: SessionBoardProject,
    session: ManualSession,
    number: number,
    actor: BoardActor,
  ): Promise<LocalMethodResult<'card.release'>> {
    const { card, held } = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, project.id);
      const card = await this.work.card(project.id, number, tx);
      const held =
        card.trackedSessionId === session.id && card.source !== 'terminal';
      if (!held && card.queuedForSessionId !== session.id) {
        throw new BoardSessionRefusal(
          'not_taken',
          `${cardLabel(card.number)} is neither held by nor queued for this session`,
        );
      }
      await tx.boardCard.update({
        where: { id: card.id },
        data: held
          ? { trackedSessionId: null, queuedForSessionId: null }
          : { queuedForSessionId: null },
      });
      return { card, held };
    });
    if (card.column !== 'todo') {
      const target = await this.work.project(project.id);
      await this.work.move(
        target,
        card,
        { to: 'todo', index: 0, source: 'person' },
        actor,
      );
    }
    await this.record(actor, project.id, card, { releasedBy: session.id });
    this.work.publish(project.id, card.id);
    const next = held ? await this.takeNext(project, session, actor) : null;
    return { number: card.number, column: 'todo', next };
  }

  /**
   * `card.finish` from a session holding a taken card (#845): the pull
   * request it opened is recorded, the card moves to Finished — a person
   * accepts it (D5) — and the session takes its next queued card. `null`
   * when the session holds no taken card here.
   */
  async finishTaken(
    project: SessionBoardProject,
    sessionId: string,
    pullRequestUrl: string | undefined,
    actor: BoardActor,
  ): Promise<LocalMethodResult<'card.finish'> | null> {
    const card = await this.prisma.boardCard.findFirst({
      where: {
        projectId: project.id,
        source: { not: 'terminal' },
        trackedSession: {
          runnerId: project.runnerId,
          runtime: 'claude',
          externalId: sessionId,
        },
      },
      include: {
        rounds: { orderBy: { round: 'desc' } },
        trackedSession: { select: { id: true, gitBranch: true } },
      },
    });
    if (!card?.trackedSession) return null;
    const session: ManualSession = card.trackedSession;
    const pr = pullRequestUrl
      ? this.pullRequestOf(project, pullRequestUrl)
      : null;
    const target = await this.work.project(project.id);
    if (pr) {
      await this.prisma.boardCard.update({
        where: { id: card.id },
        data: { prUrl: pr.url, prNumber: pr.number, prState: 'open' },
      });
    }
    if (card.column !== 'finished') {
      // The session pushed and opened the PR itself: nothing to collect.
      await this.work.move(
        target,
        card,
        { to: 'finished', index: 0, source: 'automatic', collect: false },
        actor,
      );
    }
    await this.prisma.boardCard.updateMany({
      where: { id: card.id, trackedSessionId: session.id },
      data: { trackedSessionId: null },
    });
    await this.record(actor, project.id, card, {
      finishedBy: session.id,
      ...(pr ? { prNumber: pr.number } : {}),
    });
    this.work.publish(project.id, card.id);
    const next = await this.takeNext(project, session, actor);
    return { number: card.number, finished: true, next };
  }

  /**
   * D2: the session's next queued card, in board order, is taken; one that
   * can no longer be taken loses its marker and the next is tried.
   */
  private async takeNext(
    project: SessionBoardProject,
    session: ManualSession,
    actor: BoardActor,
  ): Promise<TakenCard | null> {
    for (;;) {
      const queued = await this.prisma.boardCard.findFirst({
        where: { projectId: project.id, queuedForSessionId: session.id },
        orderBy: BOARD_ORDER,
        select: { id: true, number: true },
      });
      if (!queued) return null;
      try {
        const taken = await this.take(project, session, queued.number, actor);
        if (taken.state === 'taken') {
          const { state: _state, queuePosition: _position, ...card } = taken;
          return card;
        }
        // The session holds a card again: the rest stay queued.
        return null;
      } catch (error) {
        this.logger.warn(
          `queued ${cardLabel(queued.number)} not taken: ${(error as Error).message}`,
        );
        await this.prisma.boardCard.updateMany({
          where: { id: queued.id, queuedForSessionId: session.id },
          data: { queuedForSessionId: null },
        });
        this.work.publish(project.id, queued.id);
      }
    }
  }

  /** A pull request of this project's repository, from its URL. */
  private pullRequestOf(
    project: SessionBoardProject,
    url: string,
  ): { url: string; number: number } {
    const match = PULL_REQUEST.exec(url);
    if (!match || match[1].toLowerCase() !== project.repo.toLowerCase()) {
      throw new BadRequestException(
        `pullRequestUrl is not a pull request of ${project.repo}`,
      );
    }
    return { url: url.replace(/\/$/, ''), number: Number(match[2]) };
  }

  private async alive(
    tx: Pick<PrismaService, 'agentSession'>,
    sessionId: string,
  ): Promise<boolean> {
    return (
      (await tx.agentSession.count({
        where: { id: sessionId, endedAt: null },
      })) > 0
    );
  }

  private async lock(
    tx: Pick<PrismaService, '$executeRaw'>,
    projectId: string,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`board-take:${projectId}`}))`;
  }

  private async record(
    actor: BoardActor,
    projectId: string,
    card: Pick<BoardCard, 'id' | 'number'>,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      ...actor.ctx,
      action: 'card.updated',
      target: { type: 'board_card', id: card.id },
      projectId,
      after: { number: card.number, ...after },
      result: 'ok',
    });
  }
}
