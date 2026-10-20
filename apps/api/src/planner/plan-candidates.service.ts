import {
  type AcceptCandidateRef,
  type AcceptCandidatesRequest,
  type AcceptCandidatesResponse,
  CARD_DRAFT_TITLE_MAX,
  type CandidateDecidedDetails,
  cardLabel,
  PLANNER_ERROR,
  type PlanCandidateStack,
  type PlanCandidateView,
  type PlanTaskKind,
  planCandidateStackSchema,
  stackLabel,
  type UpdatePlanCandidateRequest,
} from '@nautelle/shared';
import { Injectable } from '@nestjs/common';
import type {
  BoardCard,
  BoardStack,
  Plan,
  PlanCandidate,
  Prisma,
} from '@prisma/client';
import { AttachmentsService } from '../attachments/attachments.service';
import { AuditService } from '../audit/audit.service';
import { BoardPlanCards } from '../board/board-plan-cards';
import { BoardStacks } from '../board/board-stacks';
import { BoardTriage } from '../board-ai/board-triage.service';
import { PrismaService } from '../database/prisma.service';
import type { PlanActor } from './plan.service';
import { PlanStore } from './plan-store';
import { plannerError } from './planner-error';

type Tx = Prisma.TransactionClient;
type Db = Pick<Tx, 'planCandidate' | 'attachment'>;

type CandidateRow = PlanCandidate & { card: { number: number } | null };

/** #592: a card the intake wrote, as a candidate keeps it. */
export interface CandidateDraft {
  title: string;
  kind: PlanTaskKind;
  body: string;
  /** The 0-based stage of the proposed stack; absent outside a stack. */
  stage?: number;
}

const NON_ASCII_LETTER = /[^\p{ASCII}]/u;

/**
 * #409: a title the person edited in a split stays English (ADR-0027 §6) —
 * it is stored as typed, with no normalization. A letter outside ASCII
 * (Cyrillic, CJK, accents) is another language; a short English title is
 * not held to the function-word share `isReliablyEnglish` applies to prose.
 */
export const isPlainTitle = (title: string): boolean =>
  ![...title].some((ch) => /\p{L}/u.test(ch) && NON_ASCII_LETTER.test(ch));

const invalid = (message: string) =>
  plannerError(400, PLANNER_ERROR.invalidArgs, message);

const stale = () =>
  plannerError(
    409,
    PLANNER_ERROR.candidateStale,
    'This candidate was changed in another tab; reload it before deciding',
  );

const decided = (row: CandidateRow) => {
  const details: CandidateDecidedDetails = {
    candidateId: row.id,
    status: row.status,
    card: row.card
      ? { number: row.card.number, label: cardLabel(row.card.number) }
      : null,
  };
  return plannerError(
    409,
    PLANNER_ERROR.candidateDecided,
    row.card
      ? `This candidate was accepted already as ${cardLabel(row.card.number)}`
      : `This candidate was ${row.status} already`,
    details,
  );
};

/** #592: a title the person typed — set, short, and English (ADR-0027 §6). */
const checkedTitle = (title: string): string => {
  const trimmed = title.trim();
  if (trimmed === '') throw invalid('A card needs a title');
  if (trimmed.length > CARD_DRAFT_TITLE_MAX) {
    throw invalid(`A title is at most ${CARD_DRAFT_TITLE_MAX} characters`);
  }
  if (!isPlainTitle(trimmed)) {
    throw invalid(
      `"${trimmed}" is not an English title: a card is written in English`,
    );
  }
  return trimmed;
};

/** The stack a plan's candidates were proposed in; one that no longer parses is none. */
export const candidateStackOf = (
  value: Prisma.JsonValue | null,
): PlanCandidateStack | null => {
  const parsed = planCandidateStackSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

export const toCandidateView = (row: CandidateRow): PlanCandidateView => ({
  id: row.id,
  planId: row.planId,
  position: row.position,
  title: row.title,
  kind: row.kind,
  body: row.body,
  stage: row.stage,
  status: row.status,
  version: row.version,
  card: row.card
    ? { number: row.card.number, label: cardLabel(row.card.number) }
    : null,
  attachments: row.attachments,
});

const withCard = { card: { select: { number: true } } } as const;

/** #592: an intake's candidates, in the proposal's order. */
export const candidatesOf = (db: Db, planId: string): Promise<CandidateRow[]> =>
  db.planCandidate.findMany({
    where: { planId },
    include: withCard,
    orderBy: { position: 'asc' },
  });

/** #592: the intake's attachments no card has taken yet. */
export const pendingAttachments = (db: Db, planId: string): Promise<number> =>
  db.attachment.count({ where: { planId, cardId: null } });

/** A card the accept makes: its candidate, in the order the cards are made. */
interface Placed {
  row: CandidateRow;
  plan: Plan;
  /** The dense 0-based stage for a stack; 0 for independent cards. */
  stage: number;
}

/**
 * New work candidates (#592, ADR-0058): the cards an intake writes wait as
 * `plan_candidates` until the person accepts them — a board card in Todo
 * with the intake as its origin — or rejects them. Every decision locks the
 * plans it touches (in id order), so two tabs deciding one candidate make
 * one card; the intake is `done` once none of its candidates is pending.
 */
@Injectable()
export class PlanCandidatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: PlanStore,
    private readonly planCards: BoardPlanCards,
    private readonly stacks: BoardStacks,
    private readonly attachments: AttachmentsService,
    private readonly audit: AuditService,
    private readonly triage: BoardTriage,
  ) {}

  /**
   * In the caller's transaction, which holds the plan's lock: the intake's
   * cards as candidates, in order, and the stack they were proposed in. The
   * intake is `reviewing` and takes the title of its first card or stack.
   */
  async write(
    tx: Tx,
    planId: string,
    drafts: readonly CandidateDraft[],
    stack: PlanCandidateStack | null,
  ): Promise<CandidateRow[]> {
    await tx.planCandidate.createMany({
      data: drafts.map((draft, position) => ({
        planId,
        position,
        title: draft.title,
        kind: draft.kind,
        body: draft.body,
        stage: stack ? (draft.stage ?? null) : null,
      })),
    });
    await tx.plan.update({
      where: { id: planId },
      data: {
        status: 'reviewing',
        title: stack ? stack.title : drafts[0].title,
        candidateStack: stack ?? undefined,
      },
    });
    return candidatesOf(tx, planId);
  }

  /** `PATCH …/candidates/:id`: the person's own title, kind or body. */
  async update(
    plan: Plan,
    candidateId: string,
    request: UpdatePlanCandidateRequest,
    actor: PlanActor,
  ): Promise<PlanCandidateView> {
    const title =
      request.title !== undefined ? checkedTitle(request.title) : undefined;
    const row = await this.prisma.$transaction(async (tx) => {
      const [fresh] = await this.lock(tx, [plan.id]);
      const current = await this.pendingOf(tx, fresh, candidateId);
      if (current.version !== request.version) throw stale();
      return tx.planCandidate.update({
        where: { id: current.id },
        data: {
          ...(title !== undefined ? { title } : {}),
          ...(request.kind !== undefined ? { kind: request.kind } : {}),
          ...(request.body !== undefined ? { body: request.body } : {}),
          version: { increment: 1 },
        },
        include: withCard,
      });
    });
    await this.audit.record({
      ...actor.ctx,
      action: 'plan.candidate_edited',
      target: { type: 'plan', id: plan.id },
      projectId: plan.projectId,
      after: { title: row.title, kind: row.kind, version: row.version },
      result: 'ok',
      meta: { candidateId: row.id },
    });
    this.store.publish(plan.projectId, plan.id);
    return toCandidateView(row);
  }

  /** `POST …/candidates/:id/reject`: no card; the intake may be done after it. */
  async reject(
    plan: Plan,
    candidateId: string,
    actor: PlanActor,
  ): Promise<PlanCandidateView> {
    const row = await this.prisma.$transaction(async (tx) => {
      const [fresh] = await this.lock(tx, [plan.id]);
      const current = await this.pendingOf(tx, fresh, candidateId);
      const updated = await tx.planCandidate.update({
        where: { id: current.id },
        data: {
          status: 'rejected',
          decidedAt: new Date(),
          decidedById: actor.userId,
        },
        include: withCard,
      });
      await this.closeIfDecided(tx, plan.id);
      return updated;
    });
    await this.audit.record({
      ...actor.ctx,
      action: 'plan.candidate_rejected',
      target: { type: 'plan', id: plan.id },
      projectId: plan.projectId,
      after: { title: row.title },
      result: 'ok',
      meta: { candidateId: row.id },
    });
    this.store.publish(plan.projectId, plan.id);
    return toCandidateView(row);
  }

  /**
   * `POST /projects/:projectId/candidates/accept` (ADR-0058 §3): the named
   * candidates of the caller's intakes become cards in Todo — independent,
   * or one stack made as Confirm of a stack makes it (ADR-0044) — in one
   * transaction. The first card of each intake takes its attachments.
   */
  async accept(
    projectId: string,
    userId: string,
    request: AcceptCandidatesRequest,
    actor: PlanActor,
  ): Promise<AcceptCandidatesResponse> {
    const refs = this.checkRefs(request);
    const located = await this.prisma.planCandidate.findMany({
      where: { id: { in: refs.map((r) => r.id) } },
      select: { id: true, planId: true },
    });
    const planOf = new Map(located.map((c) => [c.id, c.planId]));
    const missing = refs.find((r) => !planOf.has(r.id));
    if (missing) {
      throw plannerError(
        404,
        PLANNER_ERROR.notFound,
        `Candidate ${missing.id} not found`,
      );
    }
    const planIds = [...new Set(located.map((c) => c.planId))];
    for (const planId of planIds) {
      const plan = await this.store.readable(userId, projectId, planId);
      this.store.assertCurrent(plan);
    }

    const made = await this.prisma.$transaction(async (tx) => {
      const plans = new Map(
        (await this.lock(tx, planIds)).map((p) => [p.id, p]),
      );
      const rows = new Map<string, CandidateRow>();
      for (const ref of refs) {
        const plan = plans.get(planOf.get(ref.id) as string) as Plan;
        const row = await this.pendingOf(tx, plan, ref.id);
        if (row.version !== ref.version) throw stale();
        rows.set(ref.id, row);
      }
      const placed = this.place(refs, rows, plans, request.as);
      const cards = await this.planCards.create(tx, {
        projectId,
        planId: placed[0].plan.id,
        authorId: actor.userId,
        drafts: placed.map(({ row }) => ({
          title: row.title,
          kind: row.kind,
          body: row.body,
          planId: row.planId,
        })),
      });
      const stack =
        request.as === 'stack'
          ? await this.makeStack(tx, projectId, actor.userId, placed, cards)
          : null;
      // ADR-0037 §4: each intake's attachments go to its first card made.
      const claims: { cardId: string; ids: string[] }[] = [];
      const claimed = new Map<string, number>();
      for (const [i, { row }] of placed.entries()) {
        if (claimed.has(row.planId)) continue;
        const ids = await this.attachments.claimPlanOntoCard(
          tx,
          row.planId,
          cards[i].id,
        );
        claimed.set(row.planId, ids.length);
        if (ids.length > 0) claims.push({ cardId: cards[i].id, ids });
      }
      const now = new Date();
      const firstOf = new Set<string>();
      for (const [i, { row }] of placed.entries()) {
        const first = !firstOf.has(row.planId);
        firstOf.add(row.planId);
        await tx.planCandidate.update({
          where: { id: row.id },
          data: {
            status: 'accepted',
            cardId: cards[i].id,
            attachments: first ? (claimed.get(row.planId) ?? 0) : 0,
            decidedAt: now,
            decidedById: actor.userId,
          },
        });
      }
      for (const planId of planIds) await this.closeIfDecided(tx, planId);
      return { cards, placed, stack, claims };
    });

    await this.planCards.announce(made.cards, actor);
    if (made.stack) {
      await this.stacks.announce(
        made.stack.stack,
        made.cards,
        made.stack.stages,
        made.stack.design,
        actor,
      );
    }
    for (const claim of made.claims) {
      await this.attachments.recordClaim(
        projectId,
        { cardId: claim.cardId },
        claim.ids,
        actor,
      );
    }
    for (const planId of planIds) this.store.publish(projectId, planId);
    // #660: hints for the new cards, in the background.
    this.triage.request(
      made.cards.map((card) => card.id),
      actor.userId,
    );
    return {
      cards: made.cards.map((card, i) => ({
        candidateId: made.placed[i].row.id,
        number: card.number,
        label: cardLabel(card.number),
      })),
      stack: made.stack
        ? {
            number: made.stack.stack.number,
            label: stackLabel(made.stack.stack.number),
          }
        : null,
    };
  }

  /** The request's shape, before anything is read: unique ids, stages for a stack. */
  private checkRefs(request: AcceptCandidatesRequest): AcceptCandidateRef[] {
    const seen = new Set<string>();
    for (const ref of request.candidates) {
      if (seen.has(ref.id))
        throw invalid(`Candidate ${ref.id} is listed twice`);
      seen.add(ref.id);
      if (request.as === 'stack' && ref.stage === undefined) {
        throw invalid('Every candidate of a stack names its stage');
      }
    }
    if (request.as === 'stack' && request.candidates.length < 2) {
      throw invalid('A stack holds two or more cards');
    }
    return request.candidates;
  }

  /**
   * The order the cards are made in: as listed, or — for a stack — by the
   * stage chosen (as listed inside a stage), the stages closed up.
   */
  private place(
    refs: readonly AcceptCandidateRef[],
    rows: ReadonlyMap<string, CandidateRow>,
    plans: ReadonlyMap<string, Plan>,
    as: AcceptCandidatesRequest['as'],
  ): Placed[] {
    const items = refs.map((ref) => {
      const row = rows.get(ref.id) as CandidateRow;
      return {
        row,
        plan: plans.get(row.planId) as Plan,
        chosen: as === 'stack' ? (ref.stage as number) : 0,
      };
    });
    if (as === 'cards') return items.map((it) => ({ ...it, stage: 0 }));
    const dense = new Map(
      [...new Set(items.map((it) => it.chosen))]
        .sort((a, b) => a - b)
        .map((stage, i) => [stage, i]),
    );
    return items
      .map((it) => ({ ...it, stage: dense.get(it.chosen) as number }))
      .sort((a, b) => a.stage - b.stage);
  }

  /**
   * ADR-0044 as Confirm applies it: the stages, their dependencies, and the
   * shared design when a candidate's intake proposed one. One intake's
   * stack keeps its title, body and stage names; any other stack is named
   * after its first card, its stages `Stage N`.
   */
  private async makeStack(
    tx: Tx,
    projectId: string,
    authorId: string,
    placed: readonly Placed[],
    cards: readonly BoardCard[],
  ): Promise<{ stack: BoardStack; stages: number; design: boolean }> {
    const proposed = placed.map((p) => candidateStackOf(p.plan.candidateStack));
    const one = new Set(placed.map((p) => p.plan.id)).size === 1;
    const own = one ? proposed[0] : null;
    const design = proposed.some((s) => s?.design === true);
    const count = (placed.at(-1) as Placed).stage + 1;
    const stages = Array.from({ length: count }, (_, stage) => {
      const members = placed
        .map((p, i) => ({ ...p, card: cards[i] }))
        .filter((p) => p.stage === stage);
      const from = new Set(members.map((m) => m.row.stage));
      const name =
        own && from.size === 1
          ? own.stages[members[0].row.stage ?? -1]
          : undefined;
      return {
        title: name ?? `Stage ${stage + 1}`,
        cardIds: members.map((m) => m.card.id),
      };
    });
    const stack = await this.stacks.create(tx, {
      projectId,
      planId: placed[0].plan.id,
      authorId,
      title: own?.title ?? placed[0].row.title,
      body: own?.body ?? '',
      design,
      stages,
    });
    return { stack, stages: count, design };
  }

  /** Locks the plans in id order and reads them back; each must be an open intake under review. */
  private async lock(tx: Tx, planIds: readonly string[]): Promise<Plan[]> {
    const plans: Plan[] = [];
    for (const id of [...planIds].sort()) {
      await tx.$queryRaw`SELECT id FROM plans WHERE id = ${id} FOR UPDATE`;
      const plan = await tx.plan.findUniqueOrThrow({ where: { id } });
      if (plan.mode !== 'card') {
        throw plannerError(
          409,
          PLANNER_ERROR.wrongMode,
          'Only a New work intake writes candidates',
        );
      }
      plans.push(plan);
    }
    return plans;
  }

  /**
   * The candidate of that plan, still pending — a decided one is
   * `candidate_decided` — on an intake still open.
   */
  private async pendingOf(
    tx: Tx,
    plan: Plan,
    candidateId: string,
  ): Promise<CandidateRow> {
    const row = await tx.planCandidate.findFirst({
      where: { id: candidateId, planId: plan.id },
      include: withCard,
    });
    if (!row) {
      throw plannerError(404, PLANNER_ERROR.notFound, 'Candidate not found');
    }
    if (row.status !== 'pending') throw decided(row);
    this.store.assertOpen(plan);
    return row;
  }

  /** ADR-0058 §5: an intake with no pending candidate is done; it leaves Drafts. */
  private async closeIfDecided(tx: Tx, planId: string): Promise<void> {
    const pending = await tx.planCandidate.count({
      where: { planId, status: 'pending' },
    });
    if (pending > 0) return;
    await tx.plan.update({ where: { id: planId }, data: { status: 'done' } });
  }
}
