import type { StewardDigestItem } from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  DIGEST_REASON_MAX,
  DIGEST_TITLE_MAX,
  oneLine,
} from './steward-digest-text';

/** What `steward_digests.content` holds (the schema comment: `{ done, stuck, waiting, spendUsd }`). */
export interface DigestContent {
  done: StewardDigestItem[];
  stuck: StewardDigestItem[];
  waiting: StewardDigestItem[];
  spendUsd: string;
}

/** A section holds at most this many lines; the rest are not stored. */
export const DIGEST_SECTION_MAX = 50;

/** An instant as the UTC `timestamp` `llm_requests.ts` is stored as. */
const utc = (at: Date) =>
  Prisma.sql`(${at.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

const cardLabel = (number: number): string => `C-${number}`;

const item = (
  label: string,
  title: string,
  reason: string | null,
  url: string | null,
): StewardDigestItem => ({
  label: oneLine(label, DIGEST_TITLE_MAX),
  title: oneLine(title, DIGEST_TITLE_MAX),
  reason: reason === null ? null : oneLine(reason, DIGEST_REASON_MAX),
  url,
});

/**
 * Builds a project's digest content for `[from, to)` from the rows Steward,
 * the Board and the usage ledger already hold (D14). Nothing here reads a
 * project's filesystem or a session's text: every string is a stored title or
 * one-line reason, bounded and single-lined again on the way in (DA-13).
 */
@Injectable()
export class StewardDigestComposer {
  constructor(private readonly prisma: PrismaService) {}

  async compose(
    projectId: string,
    from: Date,
    to: Date,
  ): Promise<DigestContent> {
    const [done, stuck, waiting, spendUsd] = await Promise.all([
      this.done(projectId, from, to),
      this.stuck(projectId),
      this.waiting(projectId),
      this.spend(projectId, from, to),
    ]);
    return { done, stuck, waiting, spendUsd };
  }

  /** Cards merged in the window, and cards whose round finished in it. */
  private async done(
    projectId: string,
    from: Date,
    to: Date,
  ): Promise<StewardDigestItem[]> {
    const window = { gte: from, lt: to };
    const cards = await this.prisma.boardCard.findMany({
      where: {
        projectId,
        OR: [
          { mergedAt: window },
          { rounds: { some: { phase: 'finished', finishedAt: window } } },
        ],
      },
      orderBy: { number: 'asc' },
      take: DIGEST_SECTION_MAX,
      select: {
        number: true,
        title: true,
        prUrl: true,
        mergedAt: true,
      },
    });
    return cards.map((card) =>
      item(
        cardLabel(card.number),
        card.title,
        card.mergedAt ? 'merged' : 'finished',
        card.prUrl,
      ),
    );
  }

  /** Open and escalated incidents — cards, runs and fleet slots alike (D5). */
  private async stuck(projectId: string): Promise<StewardDigestItem[]> {
    const incidents = await this.prisma.stewardIncident.findMany({
      where: { projectId, status: { in: ['open', 'escalated'] } },
      orderBy: { openedAt: 'asc' },
      take: DIGEST_SECTION_MAX,
      select: { subjectKind: true, subjectId: true, reason: true },
    });
    const roundIds = incidents
      .filter((i) => i.subjectKind === 'card_round')
      .map((i) => i.subjectId);
    const runIds = incidents
      .filter((i) => i.subjectKind === 'run')
      .map((i) => i.subjectId);
    const [rounds, runs] = await Promise.all([
      roundIds.length
        ? this.prisma.boardCardRound.findMany({
            where: { id: { in: roundIds }, card: { projectId } },
            select: {
              id: true,
              card: { select: { number: true, title: true, prUrl: true } },
            },
          })
        : [],
      runIds.length
        ? this.prisma.run.findMany({
            where: { id: { in: runIds }, projectId },
            select: { id: true, kind: true, title: true },
          })
        : [],
    ]);
    const roundById = new Map(rounds.map((r) => [r.id, r.card]));
    const runById = new Map(runs.map((r) => [r.id, r]));

    const stuck: StewardDigestItem[] = [];
    for (const incident of incidents) {
      if (incident.subjectKind === 'card_round') {
        const card = roundById.get(incident.subjectId);
        stuck.push(
          item(
            card ? cardLabel(card.number) : 'Card',
            card?.title ?? 'Card round',
            incident.reason,
            card?.prUrl ?? null,
          ),
        );
      } else if (incident.subjectKind === 'run') {
        const run = runById.get(incident.subjectId);
        stuck.push(
          item('Run', run?.title ?? run?.kind ?? 'Run', incident.reason, null),
        );
      } else {
        stuck.push(
          item(incident.subjectId, 'Fleet slot', incident.reason, null),
        );
      }
    }
    return stuck;
  }

  /** Cards whose latest round waits for the person, and cards that need one (#359 D6). */
  private async waiting(projectId: string): Promise<StewardDigestItem[]> {
    const cards = await this.prisma.boardCard.findMany({
      where: {
        projectId,
        OR: [{ needsPerson: true }, { rounds: { some: { phase: 'waiting' } } }],
      },
      orderBy: { number: 'asc' },
      take: DIGEST_SECTION_MAX,
      select: {
        number: true,
        title: true,
        prUrl: true,
        needsPerson: true,
        rounds: {
          orderBy: { round: 'desc' },
          take: 1,
          select: { phase: true },
        },
      },
    });
    const waiting: StewardDigestItem[] = [];
    for (const card of cards) {
      const waits = card.rounds[0]?.phase === 'waiting';
      if (!waits && !card.needsPerson) continue;
      waiting.push(
        item(
          cardLabel(card.number),
          card.title,
          waits ? 'waiting for you' : 'CI still failing, needs you',
          card.prUrl,
        ),
      );
    }
    return waiting;
  }

  /** The project's spend in the window, attributed as budgets do (spec 28 D3). */
  private async spend(
    projectId: string,
    from: Date,
    to: Date,
  ): Promise<string> {
    const rows = await this.prisma.$queryRaw<{ spent: string }[]>(Prisma.sql`
      SELECT coalesce(sum(r."costUsd"), 0)::text AS spent
      FROM llm_requests r
      JOIN sessions s ON s.id = r."sessionId"
      WHERE s."projectId" = ${projectId}
        AND r.ts >= ${utc(from)} AND r.ts < ${utc(to)}`);
    return new Prisma.Decimal(rows[0]?.spent ?? '0').toFixed(2);
  }
}
