import type { CardDemoBrief } from '@nautelle/shared';
import type { PrismaService } from '../database/prisma.service';
import type { CardFacts, CardWithRounds } from './board-mapper';

/**
 * C-371: the tile chip's fact — each card's newest demo recording. Apart from
 * `BoardService` for the reason `reviewFactsFor` is: the demos module imports
 * the board.
 */
export const demoFactsFor = async (
  prisma: PrismaService,
  cards: readonly Pick<CardWithRounds, 'id'>[],
): Promise<Pick<CardFacts, 'demos'>> => {
  if (cards.length === 0) return {};
  const rows = await prisma.cardDemo.findMany({
    where: { cardId: { in: cards.map((c) => c.id) } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    distinct: ['cardId'],
    select: { cardId: true, status: true, durationMs: true },
  });
  const demos = new Map<string, CardDemoBrief>();
  for (const { cardId, ...brief } of rows) demos.set(cardId, brief);
  return { demos };
};
