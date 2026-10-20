import { type BoardCardKind, captureFingerprint } from '@nautelle/shared';
import { Injectable } from '@nestjs/common';
import type { BoardCard, Prisma } from '@prisma/client';
import { CardAssessor } from '../assess/card-assessor';
import { AuditService } from '../audit/audit.service';
import { toSettingsView } from './board-mapper';
import { type BoardActor, BoardWork } from './board-work';

type Tx = Prisma.TransactionClient;

/** A card a plan writes: the model's English title and body (#337 D5, D6). */
export interface PlanCardDraft {
  title: string;
  body: string;
  kind: BoardCardKind;
  /** #592: the card's own origin when it is not `PlanCardsInput.planId`. */
  planId?: string;
}

export interface PlanCardsInput {
  projectId: string;
  planId: string;
  /** The plan's author: the cards are theirs. */
  authorId: string | null;
  /** In order: the first lands on top of To Do. */
  drafts: readonly PlanCardDraft[];
  /** `[card, dependsOn]` as indexes into `drafts` — an acyclic graph (the plan's). */
  links?: readonly (readonly [number, number])[];
}

/**
 * Cards a plan makes (#337 D6, D7): a card intake's one card, or Create
 * cards' one per task. Created inside the caller's transaction, so the plan's
 * own change commits with them; `announce` runs once it has committed.
 *
 * The text is already English (the model writes it, D5): it is not sent to
 * normalization. `kindSource` is `auto` — the model chose the kind.
 */
@Injectable()
export class BoardPlanCards {
  constructor(
    private readonly work: BoardWork,
    private readonly audit: AuditService,
    private readonly assessor: CardAssessor,
  ) {}

  async create(tx: Tx, input: PlanCardsInput): Promise<BoardCard[]> {
    const settings = toSettingsView(
      input.projectId,
      await tx.boardSettings.findUnique({
        where: { projectId: input.projectId },
      }),
    );
    const now = new Date();
    const cards: BoardCard[] = [];
    for (const [index, draft] of input.drafts.entries()) {
      const next = await this.work.nextCard(tx, input.projectId);
      const position = await this.work.place(
        tx,
        { id: '', projectId: input.projectId },
        'todo',
        index,
      );
      cards.push(
        await tx.boardCard.create({
          data: {
            projectId: input.projectId,
            ...next,
            title: draft.title,
            fingerprint: captureFingerprint(draft.title),
            body: draft.body,
            kind: draft.kind,
            kindSource: 'auto',
            column: 'todo',
            position,
            issueOnRun: settings.issueOnRun,
            specOnRun: settings.specOnRun,
            planId: draft.planId ?? input.planId,
            createdById: input.authorId,
            movedById: input.authorId,
            movedAt: now,
          },
        }),
      );
    }
    const links = input.links ?? [];
    if (links.length > 0) {
      await tx.boardCardDependency.createMany({
        data: links.map(([card, dependsOn]) => ({
          cardId: cards[card].id,
          dependsOnId: cards[dependsOn].id,
        })),
        skipDuplicates: true,
      });
    }
    return cards;
  }

  /** After commit: `card.created` for each, the board's live event, the assessment (#322 D6). */
  async announce(
    cards: readonly BoardCard[],
    actor: BoardActor,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    for (const card of cards) {
      await this.audit.record({
        ...actor.ctx,
        action: 'card.created',
        target: { type: 'board_card', id: card.id },
        projectId: card.projectId,
        after: {
          number: card.number,
          title: card.title,
          kind: card.kind,
          issueOnRun: card.issueOnRun,
          specOnRun: card.specOnRun,
          planId: card.planId,
          ...extra,
        },
        result: 'ok',
      });
      this.work.publish(card.projectId, card.id);
      await this.assessor.request(card.id);
    }
  }
}
