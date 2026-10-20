import {
  BOARD_ERROR,
  type BoardCardDetail,
  CAPTURE_TITLE_MAX,
  captureFingerprint,
  type DismissAllResult,
} from '@nautelle/shared';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { BoardService } from './board.service';
import { boardError } from './board-error';
import type { CardWithRounds } from './board-mapper';
import { type BoardActor, BoardWork } from './board-work';
import type { AcceptSuggestionDto } from './dto';

const notInInbox = () =>
  boardError(409, BOARD_ERROR.wrongColumn, 'The card is not in the Inbox');

/**
 * The Inbox (issue #244 D9): a person accepts a suggestion into To Do —
 * optionally editing it on the way — or dismisses it. Dismissing deletes the
 * card and records its title's fingerprint, so capture does not suggest it
 * again for `CAPTURE_DISMISSAL_DEDUPE_DAYS`.
 */
@Injectable()
export class BoardInboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly work: BoardWork,
    private readonly board: BoardService,
    private readonly audit: AuditService,
  ) {}

  /** `POST …/accept-suggestion`: Inbox → the top of To Do, evidence stripped. */
  async accept(
    projectId: string,
    number: number,
    dto: AcceptSuggestionDto,
    actor: BoardActor,
  ): Promise<BoardCardDetail> {
    const project = await this.work.project(projectId);
    const card = await this.work.card(projectId, number);
    if (card.column !== 'inbox') throw notInInbox();
    const edits = {
      ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
      ...(dto.body !== undefined ? { body: dto.body } : {}),
      ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
    };
    if (Object.keys(edits).length > 0) {
      await this.prisma.boardCard.updateMany({
        where: { id: card.id, column: 'inbox' },
        data: {
          ...edits,
          // #271 D9: a kind the person sets is theirs from now on.
          ...(edits.kind !== undefined
            ? { kindSource: 'person' as const }
            : {}),
          ...(edits.title !== undefined
            ? { fingerprint: captureFingerprint(edits.title) }
            : {}),
        },
      });
    }
    await this.work.move(
      project,
      card,
      { to: 'todo', index: 0, source: 'person', edits },
      actor,
    );
    // #271 D1: accepted, the suggestion's text is the person's.
    await this.board.normalizeCard(
      card,
      { title: edits.title ?? card.title, body: edits.body ?? card.body },
      actor,
    );
    return this.board.detail(projectId, number);
  }

  /** `POST …/dismiss`. */
  async dismiss(
    projectId: string,
    number: number,
    actor: BoardActor,
  ): Promise<void> {
    const card = await this.work.card(projectId, number);
    if (card.column !== 'inbox') throw notInInbox();
    if (!(await this.remove(card, actor))) throw notInInbox();
  }

  /** `POST /board/inbox/dismiss-all`. */
  async dismissAll(
    projectId: string,
    actor: BoardActor,
  ): Promise<DismissAllResult> {
    const cards = await this.prisma.boardCard.findMany({
      where: { projectId, column: 'inbox' },
      include: { rounds: true },
      orderBy: [{ position: 'asc' }, { number: 'asc' }],
    });
    let dismissed = 0;
    for (const card of cards) {
      if (await this.remove(card, actor)) dismissed++;
    }
    return { dismissed };
  }

  /** Deletes the card if it is still in the Inbox and records the dismissal. */
  private async remove(
    card: CardWithRounds,
    actor: BoardActor,
  ): Promise<boolean> {
    const fingerprint = card.fingerprint ?? captureFingerprint(card.title);
    const removed = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.boardCard.deleteMany({
        where: { id: card.id, column: 'inbox' },
      });
      if (count === 0) return false;
      await tx.cardDismissal.create({
        data: {
          projectId: card.projectId,
          fingerprint,
          title: card.title.slice(0, CAPTURE_TITLE_MAX),
          dismissedById: actor.userId,
        },
      });
      return true;
    });
    if (!removed) return false;
    await this.audit.record({
      ...actor.ctx,
      action: 'card.dismissed',
      target: { type: 'board_card', id: card.id },
      projectId: card.projectId,
      before: { number: card.number, captureId: card.captureId },
      after: { fingerprint },
      result: 'ok',
    });
    this.work.publish(card.projectId, card.id);
    return true;
  }
}
