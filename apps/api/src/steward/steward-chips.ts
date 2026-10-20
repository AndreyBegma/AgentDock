import type { StewardCardChip } from '@nautelle/shared';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { actionsOf } from './steward-incidents.service';

/**
 * D15: the chip of each round — its live incident, newest first. The board
 * read passes its cards' latest round ids and hands the map to `toCardView`
 * (`CardFacts.steward`). A function, not only a provider: the board calls it
 * with its own client, as Steward's module imports the board's.
 */
export const stewardChipsFor = async (
  prisma: PrismaService,
  roundIds: readonly string[],
): Promise<Map<string, StewardCardChip>> => {
  const chips = new Map<string, StewardCardChip>();
  if (roundIds.length === 0) return chips;
  const rows = await prisma.stewardIncident.findMany({
    where: {
      subjectKind: 'card_round',
      subjectId: { in: [...new Set(roundIds)] },
      status: { in: ['open', 'escalated'] },
    },
    orderBy: { openedAt: 'desc' },
    select: {
      id: true,
      subjectId: true,
      kind: true,
      status: true,
      actions: true,
    },
  });
  for (const row of rows) {
    if (chips.has(row.subjectId) || row.status === 'resolved') continue;
    chips.set(row.subjectId, {
      incidentId: row.id,
      kind: row.kind,
      status: row.status,
      actions: actionsOf(row.actions),
    });
  }
  return chips;
};

@Injectable()
export class StewardChips {
  constructor(private readonly prisma: PrismaService) {}

  forRounds(
    roundIds: readonly string[],
  ): Promise<Map<string, StewardCardChip>> {
    return stewardChipsFor(this.prisma, roundIds);
  }
}
