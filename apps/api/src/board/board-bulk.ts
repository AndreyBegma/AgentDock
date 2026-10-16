import {
  BOARD_ERROR,
  type BoardErrorCode,
  type BulkBoardCardsResponse,
  type BulkCardAction,
  type BulkCardOutcome,
  bulkCardRule,
} from '@agentdock/shared';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import { BoardService } from './board.service';
import { BoardFailure } from './board-error';
import { type BoardActor, BoardWork } from './board-work';
import type { BulkBoardCardsDto } from './dto';

/**
 * #452: one action for several cards. Each card goes through the service path
 * of the single-card action (so its effects and its audit entry are the same),
 * after `bulkCardRule` — the rule the web counts with — has said it applies.
 * A card the rule refuses, one already where it would go, or one that is gone
 * is skipped; a refusal that only shows at the moment of the call is that
 * card's `error`. Neither stops the rest of the batch.
 */
@Injectable()
export class BoardBulk {
  private readonly log = new Logger(BoardBulk.name);

  constructor(
    private readonly board: BoardService,
    private readonly work: BoardWork,
  ) {}

  async run(
    projectId: string,
    dto: BulkBoardCardsDto,
    actor: BoardActor,
  ): Promise<BulkBoardCardsResponse> {
    const results: BulkCardOutcome[] = [];
    // One card at a time: a batch must not hold more than one card's locks.
    for (const number of dto.numbers) {
      results.push(await this.one(projectId, number, dto.action, actor));
    }
    return { action: dto.action, results };
  }

  private async one(
    projectId: string,
    number: number,
    action: BulkCardAction,
    actor: BoardActor,
  ): Promise<BulkCardOutcome> {
    try {
      const card = await this.work.card(projectId, number);
      const decision = bulkCardRule(action, {
        column: card.column,
        roundPhase: card.rounds[0]?.phase ?? null,
        source: card.source,
        autoCollect: card.autoCollect,
        // The same reading as `BoardWork.decide`.
        slotGone: card.fleetSlotGone || card.fleetSlot === null,
      });
      if (!decision.applies) {
        return { number, status: 'skipped', reason: decision.reason };
      }
      await this.apply(projectId, number, action, actor);
      return { number, status: 'done' };
    } catch (err) {
      return this.failed(number, err);
    }
  }

  private async apply(
    projectId: string,
    number: number,
    action: BulkCardAction,
    actor: BoardActor,
  ): Promise<void> {
    switch (action) {
      case 'complete':
        // Neither `merge` nor `closePr`: the card moves, its PR is left alone.
        await this.board.accept(projectId, number, {}, actor);
        return;
      case 'todo':
        await this.board.move(
          projectId,
          number,
          { column: 'todo', index: 0 },
          actor,
        );
        return;
      case 'finished':
        await this.board.finish(projectId, number, actor);
        return;
      case 'delete':
        await this.board.delete(projectId, number, actor);
    }
  }

  private failed(number: number, err: unknown): BulkCardOutcome {
    if (err instanceof BoardFailure && err.code === BOARD_ERROR.notFound) {
      return { number, status: 'skipped', reason: 'not_found' };
    }
    if (err instanceof HttpException) {
      const body = err.getResponse();
      const code =
        typeof body === 'object' && 'error' in body
          ? (body.error as BoardErrorCode)
          : 'unknown';
      return { number, status: 'error', code, message: err.message };
    }
    this.log.error(`Bulk action on card ${number} failed`, err);
    return {
      number,
      status: 'error',
      code: 'unknown',
      message: 'The action failed',
    };
  }
}
