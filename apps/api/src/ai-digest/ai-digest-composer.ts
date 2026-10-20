import {
  type AiDigestItem,
  type AiDigestSections,
  DIGEST_REASON_MAX,
  DIGEST_TITLE_MAX,
  oneLine,
} from '@nautelle/shared';
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import {
  TELEGRAM_OPTIONS,
  type TelegramOptions,
} from '../telegram/telegram-options';

/** A section holds at most this many lines; the rest are not stored. */
export const AI_DIGEST_SECTION_MAX = 40;

/** How the Board moved in the period, for the overview only. */
export interface AiDigestBoardChanges {
  created: number;
  moved: number;
  completed: number;
  merged: number;
}

export interface AiDigestFacts {
  sections: AiDigestSections;
  board: AiDigestBoardChanges;
}

interface CardRef {
  number: number;
  title: string;
  prUrl: string | null;
}

/** One list per section, without a second line for the same subject and reason. */
class Section {
  readonly items: AiDigestItem[] = [];
  private readonly seen = new Set<string>();

  add(item: AiDigestItem): void {
    const key = `${item.label}\u0000${item.reason ?? ''}`;
    if (this.seen.has(key) || this.items.length >= AI_DIGEST_SECTION_MAX)
      return;
    this.seen.add(key);
    this.items.push(item);
  }
}

/**
 * The facts of a project's daily AI digest for `[from, to)` (#658): what got
 * done (merged PRs, finished rounds), what is stuck (failing PRs, failed
 * rounds, Steward incidents) and what waits for a person (a question, a PR to
 * review, a new card to triage), plus how the Board moved. Every string is a
 * stored title or one-line reason, bounded again on the way in; nothing here
 * reads a project's files or a session's text (ADR-0001).
 */
@Injectable()
export class AiDigestComposer {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TELEGRAM_OPTIONS) private readonly options: TelegramOptions,
  ) {}

  async compose(
    projectId: string,
    from: Date,
    to: Date,
  ): Promise<AiDigestFacts> {
    const window = { gte: from, lt: to };
    const done = new Section();
    const stuck = new Section();
    const waiting = new Section();

    const [merged, finished, failing, failedRounds, incidents] =
      await Promise.all([
        this.prisma.boardCard.findMany({
          where: { projectId, mergedAt: window },
          orderBy: { number: 'asc' },
          select: { number: true, title: true, prUrl: true },
        }),
        this.prisma.boardCard.findMany({
          where: {
            projectId,
            mergedAt: null,
            rounds: { some: { phase: 'finished', finishedAt: window } },
          },
          orderBy: { number: 'asc' },
          select: { number: true, title: true, prUrl: true },
        }),
        this.prisma.boardCard.findMany({
          where: {
            projectId,
            ciState: 'red',
            prState: { in: ['open', 'draft'] },
          },
          orderBy: { number: 'asc' },
          select: { number: true, title: true, prUrl: true, prNumber: true },
        }),
        this.prisma.boardCardRound.findMany({
          where: {
            phase: 'failed',
            endedAt: window,
            card: { projectId, column: { not: 'completed' } },
          },
          orderBy: { endedAt: 'asc' },
          select: {
            error: true,
            card: { select: { number: true, title: true, prUrl: true } },
          },
        }),
        this.prisma.stewardIncident.findMany({
          where: { projectId, status: { in: ['open', 'escalated'] } },
          orderBy: { openedAt: 'asc' },
          select: { subjectKind: true, subjectId: true, reason: true },
        }),
      ]);

    for (const card of merged) {
      done.add(this.cardItem(projectId, card, 'PR merged'));
    }
    for (const card of finished) {
      done.add(this.cardItem(projectId, card, 'round finished'));
    }
    for (const card of failing) {
      stuck.add(
        this.cardItem(
          projectId,
          card,
          card.prNumber === null
            ? 'checks failing'
            : `checks failing on PR #${card.prNumber}`,
        ),
      );
    }
    for (const round of failedRounds) {
      stuck.add(
        this.cardItem(
          projectId,
          round.card,
          round.error ? `round failed: ${round.error}` : 'round failed',
        ),
      );
    }
    for (const item of await this.incidentItems(projectId, incidents)) {
      stuck.add(item);
    }
    for (const item of await this.waitingItems(projectId, from, to)) {
      waiting.add(item);
    }

    const [created, moved, completed] = await Promise.all([
      this.prisma.boardCard.count({ where: { projectId, createdAt: window } }),
      this.prisma.boardCard.count({ where: { projectId, movedAt: window } }),
      this.prisma.boardCard.count({
        where: { projectId, completedAt: window },
      }),
    ]);
    return {
      sections: {
        done: done.items,
        stuck: stuck.items,
        waiting: waiting.items,
      },
      board: { created, moved, completed, merged: merged.length },
    };
  }

  /** The card on the web Board, when `APP_URL` is set. */
  private cardUrl(projectId: string, number: number): string | null {
    return this.options.appUrl
      ? `${this.options.appUrl}/projects/${projectId}/board?card=${number}`
      : null;
  }

  private cardItem(
    projectId: string,
    card: CardRef,
    reason: string,
  ): AiDigestItem {
    return {
      label: `C-${card.number}`,
      title: oneLine(card.title, DIGEST_TITLE_MAX),
      reason: oneLine(reason, DIGEST_REASON_MAX),
      url: card.prUrl ?? this.cardUrl(projectId, card.number),
    };
  }

  /** Open and escalated Steward incidents: card rounds, runs and fleet slots. */
  private async incidentItems(
    projectId: string,
    incidents: { subjectKind: string; subjectId: string; reason: string }[],
  ): Promise<AiDigestItem[]> {
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
    const cardOf = new Map(rounds.map((r) => [r.id, r.card]));
    const runOf = new Map(runs.map((r) => [r.id, r]));
    return incidents.map((incident) => {
      const reason = oneLine(incident.reason, DIGEST_REASON_MAX);
      if (incident.subjectKind === 'card_round') {
        const card = cardOf.get(incident.subjectId);
        if (card) return this.cardItem(projectId, card, incident.reason);
        return { label: 'Card', title: 'Card round', reason, url: null };
      }
      if (incident.subjectKind === 'run') {
        const run = runOf.get(incident.subjectId);
        return {
          label: 'Run',
          title: oneLine(run?.title ?? run?.kind ?? 'Run', DIGEST_TITLE_MAX),
          reason,
          url: null,
        };
      }
      return {
        label: oneLine(incident.subjectId, DIGEST_TITLE_MAX),
        title: 'Fleet slot',
        reason,
        url: this.options.appUrl
          ? `${this.options.appUrl}/projects/${projectId}/fleet`
          : null,
      };
    });
  }

  /**
   * A card whose round asks the person, a card that needs one (#359 D6), a
   * finished card whose PR waits for review, and a card new in the period
   * still in Inbox.
   */
  private async waitingItems(
    projectId: string,
    from: Date,
    to: Date,
  ): Promise<AiDigestItem[]> {
    const cards = await this.prisma.boardCard.findMany({
      where: {
        projectId,
        OR: [
          { needsPerson: true },
          { rounds: { some: { phase: 'waiting' } } },
          { column: 'finished', prState: { in: ['open', 'draft'] } },
          { column: 'inbox', createdAt: { gte: from, lt: to } },
        ],
      },
      orderBy: { number: 'asc' },
      take: AI_DIGEST_SECTION_MAX * 2,
      select: {
        number: true,
        title: true,
        prUrl: true,
        prNumber: true,
        column: true,
        createdAt: true,
        needsPerson: true,
        needsPersonReason: true,
        rounds: {
          orderBy: { round: 'desc' },
          take: 1,
          select: { phase: true },
        },
      },
    });
    const items: AiDigestItem[] = [];
    for (const card of cards) {
      let reason: string | null = null;
      if (card.rounds[0]?.phase === 'waiting') reason = 'the agent asks you';
      else if (card.needsPerson)
        reason = card.needsPersonReason ?? 'needs a person';
      else if (card.column === 'finished')
        reason =
          card.prNumber === null
            ? 'ready for review'
            : `PR #${card.prNumber} ready for review`;
      else if (card.column === 'inbox' && card.createdAt >= from)
        reason = 'new card to triage';
      if (reason) items.push(this.cardItem(projectId, card, reason));
    }
    return items;
  }
}
