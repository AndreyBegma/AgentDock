import {
  type BoardWatchCard,
  cardLabel,
  decodeBoardWaitCursor,
  diffBoardWatch,
  encodeBoardWaitCursor,
  isActiveRoundPhase,
  pendingQuestionSchema,
  type Role,
} from '@nautelle/shared';
import type {
  LocalMethodArgs,
  LocalMethodResult,
} from '@nautelle/shared/protocol';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { BoardWork } from './board-work';
import { seesInbox } from './inbox-access';

/**
 * ADR-0083 §7: a held wait re-diffs this often, so a change made on another
 * API instance, or one whose `board.changed` was lost, still answers.
 */
export const BOARD_WAIT_TICK_MS = 2_000;

const WATCH_SELECT = {
  number: true,
  title: true,
  column: true,
  ciState: true,
  prState: true,
  prNumber: true,
  mergedAt: true,
  rounds: {
    orderBy: { round: 'desc' },
    take: 1,
    select: { round: true, phase: true, pendingQuestion: true },
  },
} satisfies Prisma.BoardCardSelect;

type WatchRow = Prisma.BoardCardGetPayload<{ select: typeof WATCH_SELECT }>;

const watchCardOf = (row: WatchRow): BoardWatchCard => {
  const round = row.rounds[0];
  const question =
    round && isActiveRoundPhase(round.phase) && round.pendingQuestion !== null
      ? pendingQuestionSchema.safeParse(round.pendingQuestion)
      : null;
  return {
    number: row.number,
    label: cardLabel(row.number),
    title: row.title,
    column: row.column,
    round: round?.round ?? null,
    roundPhase: round?.phase ?? null,
    ciState: row.ciState,
    merged: row.mergedAt !== null || row.prState === 'merged',
    prNumber: row.prNumber,
    question: question?.success ? question.data : null,
  };
};

/**
 * `board.wait` (#845 D8, ADR-0083 §7): a diff of the cursor's snapshot
 * against the board now, held until the first change or `timeoutSec`. The
 * in-process `board.changed` only wakes it early; a tick re-diffs anyway.
 */
@Injectable()
export class BoardWaitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly work: BoardWork,
  ) {}

  async wait(
    projectId: string,
    role: Role,
    args: LocalMethodArgs<'board.wait'>,
  ): Promise<LocalMethodResult<'board.wait'>> {
    const numbers = args.cards ?? null;
    const prior = args.cursor
      ? decodeBoardWaitCursor(args.cursor, projectId)
      : null;
    const known = prior ? [...prior.cards.keys()] : [];
    const watched = (card: BoardWatchCard) =>
      numbers
        ? numbers.includes(card.number)
        : card.column !== 'inbox' && card.column !== 'completed';
    const answer = (
      events: LocalMethodResult<'board.wait'>['events'],
      current: BoardWatchCard[],
    ) => ({
      events,
      cursor: encodeBoardWaitCursor(projectId, current.filter(watched)),
    });

    let current = await this.read(projectId, role, numbers, known);
    // A malformed or another project's cursor is answered like none.
    if (!prior) return answer([], current);
    const deadline = Date.now() + args.timeoutSec * 1_000;
    for (;;) {
      const events = diffBoardWatch(prior, current);
      const left = deadline - Date.now();
      if (events.length > 0 || left <= 0) return answer(events, current);
      await this.changed(projectId, Math.min(BOARD_WAIT_TICK_MS, left));
      current = await this.read(projectId, role, numbers, known);
    }
  }

  /**
   * The watched cards — `numbers`, else every open card outside Inbox and
   * Completed — plus every card of the cursor that still exists, so one
   * that left reports where it went. A viewer never sees an Inbox card.
   */
  private async read(
    projectId: string,
    role: Role,
    numbers: number[] | null,
    known: number[],
  ): Promise<BoardWatchCard[]> {
    const rows = await this.prisma.boardCard.findMany({
      where: {
        projectId,
        ...(seesInbox(role) ? {} : { column: { not: 'inbox' } }),
        OR: [
          numbers
            ? { number: { in: numbers } }
            : { column: { notIn: ['inbox', 'completed'] } },
          ...(known.length > 0 ? [{ number: { in: known } }] : []),
        ],
      },
      select: WATCH_SELECT,
    });
    return rows.map(watchCardOf);
  }

  /** Resolves on the project's next `board.changed`, or after `ms`. */
  private changed(projectId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      let stop: () => void = () => {};
      const timer = setTimeout(() => {
        stop();
        resolve();
      }, ms);
      stop = this.work.watch((changedProject) => {
        if (changedProject !== projectId) return;
        clearTimeout(timer);
        stop();
        resolve();
      });
    });
  }
}
