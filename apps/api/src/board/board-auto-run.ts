import { cardLabel } from '@agentdock/shared';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { BoardCard } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { autoRunFailureOf } from './board-error';
import { BoardRoundsService } from './board-rounds.service';
import { type BoardActor, BoardWork } from './board-work';

/**
 * Auto-run when ready (#443): accepting a card starts the Run of every To Do
 * card that waited for it, has the switch on and now has no open dependency
 * — as the person who accepted, under the manual Run's rules (slots, budget,
 * profile). A refusal is not queued: it is stored on the card
 * (`autoRunFailure` with `after`) and audited, like a refused design
 * auto-run (#273 D9).
 */
@Injectable()
export class BoardAutoRun implements OnModuleInit {
  private readonly logger = new Logger(BoardAutoRun.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly work: BoardWork,
    private readonly rounds: BoardRoundsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.work.onAccepted((projectId, card, actor) =>
      this.afterAccepted(projectId, card, actor),
    );
  }

  /** The dependants of `accepted` with the switch on, in number order. */
  async afterAccepted(
    projectId: string,
    accepted: Pick<BoardCard, 'id' | 'number'>,
    actor: BoardActor,
  ): Promise<void> {
    const cards = await this.prisma.boardCard.findMany({
      where: {
        projectId,
        column: 'todo',
        autoRunWhenReady: true,
        dependsOn: { some: { dependsOnId: accepted.id } },
      },
      select: { id: true, number: true },
      orderBy: { number: 'asc' },
    });
    for (const card of cards) {
      if (await this.claim(card.id)) {
        await this.start(projectId, card, accepted.number, actor);
      }
    }
  }

  /**
   * One UPDATE turns the switch off only while the card is a To Do card with
   * it on and no open dependency. Every acceptance tries it after its own
   * commit, so the last one to commit sees every dependency accepted; of
   * acceptances that race, the row lock lets one through and the rest
   * re-read the switch off. The Run starts exactly once.
   */
  private async claim(cardId: string): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE board_cards AS card
         SET "autoRunWhenReady" = false, "updatedAt" = now()
       WHERE card.id = ${cardId}
         AND card."autoRunWhenReady"
         AND card."column" = 'todo'
         AND NOT EXISTS (
           SELECT 1
             FROM board_card_dependencies AS dep
             JOIN board_cards AS target ON target.id = dep."dependsOnId"
            WHERE dep."cardId" = card.id
              AND target."column" <> 'completed'
         )`;
    return count === 1;
  }

  private async start(
    projectId: string,
    card: Pick<BoardCard, 'id' | 'number'>,
    after: number,
    actor: BoardActor,
  ): Promise<void> {
    try {
      await this.rounds.run(projectId, card.number, {}, actor, after);
    } catch (error) {
      const { code, message } = autoRunFailureOf(error);
      this.logger.warn(
        `auto-run of ${cardLabel(card.number)} after ${cardLabel(after)} refused: ${message}`,
      );
      await this.prisma.boardCard.update({
        where: { id: card.id },
        data: {
          autoRunError: code,
          autoRunMessage: message,
          autoRunFailedAt: new Date(),
          autoRunAfter: after,
          autoRunStack: null,
        },
      });
      await this.audit.record({
        ...actor.ctx,
        action: 'card.auto_run_failed',
        target: { type: 'board_card', id: card.id },
        projectId,
        // `code` is a redacted audit key (auth codes): the refusal goes as `error`.
        after: { number: card.number, error: code, after },
        result: 'error',
        meta: { message },
      });
      this.work.publish(projectId, card.id);
    }
  }
}
