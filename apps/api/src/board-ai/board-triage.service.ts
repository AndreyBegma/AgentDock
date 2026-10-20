import {
  type BoardColumn,
  type BoardTriageCounts,
  type CardTriageView,
  cardLabel,
  type TriageHint,
} from '@nautelle/shared';
import { Injectable, Logger } from '@nestjs/common';
import {
  type BoardCardKind,
  type BoardCardTriage,
  type LlmProvider,
  Prisma,
} from '@prisma/client';
import { BoardService } from '../board/board.service';
import { cardNotFound } from '../board/board-error';
import { type BoardActor, BoardWork } from '../board/board-work';
import { PrismaService } from '../database/prisma.service';
import { LlmError } from '../llm/llm-error';
import { LlmGateway } from '../llm/llm-gateway.service';
import { boardAiError } from './board-ai-error';
import { BoardAiModel } from './board-ai-model';
import { modelJson } from './model-json';
import { triagePrompt } from './prompts';
import { likelyDuplicates } from './similarity';
import { parseTriageAnswer } from './triage-answer';

/** The columns of open work: what a new card may duplicate. */
const OPEN_COLUMNS: BoardColumn[] = ['todo', 'in_progress', 'finished'];

/** Open cards read to look for duplicates, newest first. */
const OPEN_READ_MAX = 300;

/** Open cards the model is shown, the most alike first. */
const SHOWN_MAX = 10;

/** Output tokens of a triage call. */
const TRIAGE_MAX_TOKENS = 600;

interface StoredDuplicate {
  cardId: string;
  reason: string;
}

const storedDuplicates = (value: unknown): StoredDuplicate[] =>
  Array.isArray(value)
    ? value.filter(
        (d): d is StoredDuplicate =>
          typeof d === 'object' &&
          d !== null &&
          typeof (d as StoredDuplicate).cardId === 'string' &&
          typeof (d as StoredDuplicate).reason === 'string',
      )
    : [];

const HIDDEN: CardTriageView = {
  state: 'hidden',
  duplicates: null,
  kind: null,
  priority: null,
};

/**
 * #660 triage hints: when the intake or the assistant makes a card, one model
 * call (tagged `triage`) looks for open cards it duplicates and suggests a
 * kind and a priority. It runs after the card is made and never holds it up.
 * The hints are advice: nothing changes the card until the person applies a
 * hint, and each can be dismissed. While the triage provider is at its cap no
 * hint is shown. The card's model recommendation stays ADR-0032's.
 */
@Injectable()
export class BoardTriage {
  private readonly logger = new Logger(BoardTriage.name);
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: LlmGateway,
    private readonly model: BoardAiModel,
    private readonly board: BoardService,
    private readonly work: BoardWork,
  ) {}

  /**
   * Triage of new cards, in the background; a card already triaged is
   * skipped. Never throws: a failure here must not fail the card's creation.
   */
  request(cardIds: readonly string[], userId: string | null): void {
    if (cardIds.length === 0) return;
    const run = (async () => {
      const created = await this.prisma.boardCardTriage.createManyAndReturn({
        data: cardIds.map((cardId) => ({ cardId, userId })),
        skipDuplicates: true,
        select: { cardId: true },
      });
      for (const { cardId } of created) {
        await this.run(cardId).catch((error: unknown) =>
          this.logger.warn(
            `triage of ${cardId} failed: ${(error as Error).message}`,
          ),
        );
      }
    })().catch((error: unknown) =>
      this.logger.warn(`triage not started: ${(error as Error).message}`),
    );
    this.running.add(run);
    void run.finally(() => this.running.delete(run));
  }

  /** Resolves once every triage started so far has ended. */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  private async run(cardId: string): Promise<void> {
    const triage = await this.prisma.boardCardTriage.findUnique({
      where: { cardId },
      include: { card: true },
    });
    if (!triage || triage.state !== 'pending') return;
    const { card } = triage;
    const finish = async (data: Prisma.BoardCardTriageUncheckedUpdateInput) => {
      await this.prisma.boardCardTriage.update({ where: { cardId }, data });
      this.work.publish(card.projectId, card.id);
    };

    const picked = await this.model.find();
    if (!picked) {
      await finish({ state: 'hidden' });
      return;
    }
    const open = await this.prisma.boardCard.findMany({
      where: {
        projectId: card.projectId,
        id: { not: card.id },
        column: { in: OPEN_COLUMNS },
      },
      orderBy: { updatedAt: 'desc' },
      take: OPEN_READ_MAX,
      select: { id: true, number: true, title: true, body: true, column: true },
    });
    const shown = likelyDuplicates(card, open, SHOWN_MAX);

    let text: string;
    let callId: string | undefined;
    try {
      const done = await this.gateway.complete({
        userId: triage.userId,
        feature: 'triage',
        provider: picked.provider,
        request: {
          model: picked.model,
          system: triagePrompt({ card, open: shown }),
          messages: [{ role: 'user', content: 'Triage the new card.' }],
          maxTokens: TRIAGE_MAX_TOKENS,
        },
      });
      text = done.text;
      callId = done.callId;
    } catch (error) {
      // A refusal of the gateway (cap, disabled provider, no key) hides the
      // hints; anything else failed them. Either way nothing is shown.
      await finish({
        state: error instanceof LlmError ? 'hidden' : 'failed',
        provider: picked.provider,
      });
      if (!(error instanceof LlmError)) throw error;
      return;
    }

    const answer = parseTriageAnswer(
      modelJson(text),
      card,
      new Set(shown.map((c) => c.number)),
    );
    if (!answer) {
      await finish({
        state: 'failed',
        provider: picked.provider,
        llmCallId: callId,
      });
      return;
    }
    const idOf = new Map(shown.map((c) => [c.number, c.id]));
    await finish({
      state: 'ready',
      provider: picked.provider,
      llmCallId: callId ?? null,
      duplicates: answer.duplicates.map((d) => ({
        cardId: idOf.get(d.number) as string,
        reason: d.reason,
      })) satisfies StoredDuplicate[] as Prisma.InputJsonValue,
      suggestedKind: answer.kind?.value ?? null,
      kindReason: answer.kind?.reason ?? null,
      suggestedPriority: answer.priority?.value ?? null,
      priorityReason: answer.priority?.reason ?? null,
    });
  }

  /** `GET …/board/cards/:number/triage`. */
  async view(projectId: string, number: number): Promise<CardTriageView> {
    const card = await this.prisma.boardCard.findUnique({
      where: { projectId_number: { projectId, number } },
      select: { kind: true, triage: true },
    });
    if (!card) throw cardNotFound();
    const triage = card.triage;
    if (!triage || triage.state !== 'ready') {
      return {
        ...HIDDEN,
        state: triage?.state === 'pending' ? 'pending' : 'hidden',
      };
    }
    if (await this.capped(triage.provider)) return HIDDEN;
    return this.toView(projectId, triage, card.kind);
  }

  /** `GET …/board/triage`: the cards with hints to show, and how many each. */
  async counts(projectId: string): Promise<BoardTriageCounts> {
    const rows = await this.prisma.boardCardTriage.findMany({
      where: { state: 'ready', card: { projectId } },
      include: { card: { select: { number: true, kind: true } } },
    });
    const capped = new Map<LlmProvider | null, boolean>();
    const cards: BoardTriageCounts['cards'] = [];
    for (const row of rows) {
      if (!capped.has(row.provider)) {
        capped.set(row.provider, await this.capped(row.provider));
      }
      if (capped.get(row.provider)) continue;
      const view = await this.toView(projectId, row, row.card.kind);
      const hints =
        (view.duplicates ? 1 : 0) +
        (view.kind ? 1 : 0) +
        (view.priority ? 1 : 0);
      if (hints > 0) cards.push({ number: row.card.number, hints });
    }
    return { cards };
  }

  /** `POST …/triage/dismiss`: the hint is never shown again. */
  async dismiss(
    projectId: string,
    number: number,
    hint: TriageHint,
  ): Promise<CardTriageView> {
    const triage = await this.ready(projectId, number);
    const field = {
      duplicates: 'duplicatesDismissedAt',
      kind: 'kindDismissedAt',
      priority: 'priorityDismissedAt',
    }[hint];
    await this.prisma.boardCardTriage.update({
      where: { cardId: triage.cardId },
      data: { [field]: new Date() },
    });
    this.work.publish(projectId, triage.cardId);
    return this.view(projectId, number);
  }

  /**
   * `POST …/triage/apply`: the person accepts a kind or a priority. A kind is
   * set as an edit of the card would set it; a priority moves the card to the
   * top (`high`) or the bottom (`low`) of its column. Duplicates are links,
   * never applied.
   */
  async apply(
    projectId: string,
    number: number,
    hint: TriageHint,
    actor: BoardActor,
  ): Promise<CardTriageView> {
    const triage = await this.ready(projectId, number);
    if (hint === 'kind') {
      if (
        !triage.suggestedKind ||
        triage.kindDismissedAt ||
        triage.kindAppliedAt
      ) {
        throw hintGone();
      }
      await this.board.update(
        projectId,
        number,
        { kind: triage.suggestedKind },
        actor,
      );
      await this.prisma.boardCardTriage.update({
        where: { cardId: triage.cardId },
        data: { kindAppliedAt: new Date() },
      });
    } else if (hint === 'priority') {
      if (
        !triage.suggestedPriority ||
        triage.priorityDismissedAt ||
        triage.priorityAppliedAt
      ) {
        throw hintGone();
      }
      const card = await this.prisma.boardCard.findUniqueOrThrow({
        where: { id: triage.cardId },
        select: { column: true },
      });
      await this.board.move(
        projectId,
        number,
        {
          column: card.column,
          // Clamped to the column's end.
          index: triage.suggestedPriority === 'high' ? 0 : 1_000_000,
        },
        actor,
      );
      await this.prisma.boardCardTriage.update({
        where: { cardId: triage.cardId },
        data: { priorityAppliedAt: new Date() },
      });
    } else {
      throw boardAiError(
        400,
        'triage_hint_gone',
        'Duplicates are links: open the card, or dismiss the hint',
      );
    }
    this.work.publish(projectId, triage.cardId);
    return this.view(projectId, number);
  }

  private async ready(projectId: string, number: number) {
    const card = await this.prisma.boardCard.findUnique({
      where: { projectId_number: { projectId, number } },
      select: { triage: true },
    });
    if (!card) throw cardNotFound();
    if (!card.triage || card.triage.state !== 'ready') {
      throw boardAiError(404, 'triage_not_found', 'This card has no hints');
    }
    return card.triage;
  }

  private async capped(provider: LlmProvider | null): Promise<boolean> {
    return provider !== null && (await this.model.capReached(provider));
  }

  private async toView(
    projectId: string,
    triage: BoardCardTriage,
    kind: BoardCardKind,
  ): Promise<CardTriageView> {
    const stored = triage.duplicatesDismissedAt
      ? []
      : storedDuplicates(triage.duplicates);
    // A duplicate that was since accepted or deleted is no longer one.
    const open =
      stored.length > 0
        ? await this.prisma.boardCard.findMany({
            where: {
              projectId,
              id: { in: stored.map((d) => d.cardId) },
              column: { in: OPEN_COLUMNS },
            },
            select: { id: true, number: true, title: true, column: true },
          })
        : [];
    const byId = new Map(open.map((c) => [c.id, c]));
    const duplicates = stored.flatMap((d) => {
      const card = byId.get(d.cardId);
      return card
        ? [
            {
              number: card.number,
              label: cardLabel(card.number),
              title: card.title,
              column: card.column,
              reason: d.reason,
            },
          ]
        : [];
    });
    const priority = triage.suggestedPriority;
    return {
      state: 'ready',
      duplicates: duplicates.length > 0 ? duplicates : null,
      kind:
        triage.suggestedKind &&
        // A person who set the kind since needs no hint for it.
        triage.suggestedKind !== kind &&
        !triage.kindDismissedAt &&
        !triage.kindAppliedAt
          ? { value: triage.suggestedKind, reason: triage.kindReason ?? '' }
          : null,
      priority:
        (priority === 'high' || priority === 'low') &&
        !triage.priorityDismissedAt &&
        !triage.priorityAppliedAt
          ? { value: priority, reason: triage.priorityReason ?? '' }
          : null,
    };
  }
}

const hintGone = () =>
  boardAiError(
    409,
    'triage_hint_gone',
    'This hint was already dismissed or applied',
  );
