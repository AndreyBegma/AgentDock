import {
  type AcceptCandidatesRequest,
  type AcceptCandidatesResponse,
  type CandidateDecidedDetails,
  PLANNER_ERROR,
  type PlanCandidateView,
  type PlanDetail,
} from '@nautelle/shared';
import { ApiError } from '../api';
import { pluralize } from '../format';
import { draftTitle, splitRowProblem } from './intake';

/**
 * New work candidates (#592, ADR-0058): the cards an intake wrote wait in
 * Drafts until the person accepts them — alone, all at once, as independent
 * cards or as one stack — or rejects them. What the Drafts strip, the
 * candidate sheet and the accept dialogs share about them. Pure.
 */

/** A candidate, with the intake it came from. */
export interface IntakeCandidate {
  candidate: PlanCandidateView;
  plan: PlanDetail;
}

/** The intake is under review: its cards wait as candidates. */
export const isUnderReview = (plan: PlanDetail | undefined): boolean =>
  plan?.mode === 'card' && plan.status === 'reviewing';

export const candidatesOf = (plan: PlanDetail): PlanCandidateView[] =>
  plan.intake?.candidates ?? [];

export const pendingOf = (plan: PlanDetail): PlanCandidateView[] =>
  candidatesOf(plan).filter((c) => c.status === 'pending');

/** "6 candidates waiting" — every pending candidate on the strip. */
export const waitingText = (plans: readonly PlanDetail[]): string | null => {
  const n = plans.reduce((sum, p) => sum + pendingOf(p).length, 0);
  return n > 0 ? `${pluralize(n, 'candidate')} waiting` : null;
};

/**
 * The line under an intake's title: one card to review, or the proposal —
 * a stack's stages, a split's cards — and, once a row is decided, how many.
 */
export function groupMetaText(plan: PlanDetail): string {
  const all = candidatesOf(plan);
  if (all.length === 1) return '1 card to review';
  const decided = all.length - pendingOf(plan).length;
  const stack = plan.intake?.candidateStack;
  const shape = stack ? 'Proposed stack' : 'Proposed split';
  if (decided > 0) return `${shape} · ${decided} of ${all.length} decided`;
  return stack
    ? `${shape} · ${pluralize(stack.stages.length, 'stage')}`
    : `${shape} · ${pluralize(all.length, 'card')}`;
}

/** Accept all on an untouched proposal; Accept rest once a row is decided. Null for one card. */
export function acceptAllLabel(plan: PlanDetail): string | null {
  const all = candidatesOf(plan);
  const pending = pendingOf(plan);
  if (all.length < 2 || pending.length === 0) return null;
  return pending.length < all.length ? 'Accept rest' : 'Accept all';
}

/**
 * Accept all: the pending candidates as the intake proposed them — its
 * stack, in its stages, while two or more remain; else independent cards.
 */
export function acceptAllRequest(plan: PlanDetail): AcceptCandidatesRequest {
  const pending = pendingOf(plan);
  const stack = plan.intake?.candidateStack && pending.length >= 2;
  return {
    as: stack ? 'stack' : 'cards',
    candidates: pending.map((c) => ({
      id: c.id,
      version: c.version,
      ...(stack ? { stage: c.stage ?? 0 } : {}),
    })),
  };
}

/** One candidate accepted on its own. */
export const acceptOneRequest = (
  candidate: PlanCandidateView,
): AcceptCandidatesRequest => ({
  as: 'cards',
  candidates: [{ id: candidate.id, version: candidate.version }],
});

/** The selection accepted as independent cards, in the order shown. */
export const acceptCardsRequest = (
  selected: readonly IntakeCandidate[],
): AcceptCandidatesRequest => ({
  as: 'cards',
  candidates: selected.map(({ candidate }) => ({
    id: candidate.id,
    version: candidate.version,
  })),
});

/** The body's opening prose for a row: no headings, no list marks, one line. */
export function excerptOf(body: string): string {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.replace(/^([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Cost dashboard per project · stage 2 of 3" — where a candidate sits. */
export function candidateContext(
  plan: PlanDetail,
  candidate: PlanCandidateView,
): string {
  const stack = plan.intake?.candidateStack;
  const title = draftTitle(plan);
  if (!stack || candidate.stage === null) return title;
  return `${title} · stage ${candidate.stage + 1} of ${stack.stages.length}`;
}

/** The sheet's "Depends on" line for a candidate of a proposed stack; null without one. */
export function dependsOnText(
  plan: PlanDetail,
  candidate: PlanCandidateView,
): string | null {
  if (candidate.stage === null || candidate.stage === 0) return null;
  const before = candidatesOf(plan).filter(
    (c) => c.stage === (candidate.stage as number) - 1,
  );
  if (before.length === 0) return null;
  return `Stage ${candidate.stage} · ${before.map((c) => c.title).join(', ')}`;
}

/** The sheet's "Attachments" line: where the intake's files go on accept. */
export function attachmentsText(
  plan: PlanDetail,
  candidate: PlanCandidateView,
): string | null {
  if (candidate.attachments > 0) {
    return `${candidate.attachments} — went to this card`;
  }
  const left = plan.intake?.attachmentsLeft ?? 0;
  if (left === 0) return null;
  return pendingOf(plan).length === 1
    ? `${left} — ${left === 1 ? 'goes' : 'go'} to this card on accept`
    : `${left} — go to the first card you accept from this intake`;
}

const NON_ASCII_LETTER = /[^\p{ASCII}]/u;

/**
 * Why the title cannot be saved — the API's rule (`isPlainTitle`), said
 * first: set, at most `CARD_DRAFT_TITLE_MAX`, no letter outside ASCII.
 */
export function candidateTitleProblem(title: string): string | null {
  const english = ![...title].some(
    (ch) => /\p{L}/u.test(ch) && NON_ASCII_LETTER.test(ch),
  );
  if (title.trim() !== '' && !english) {
    return 'The title has non-ASCII letters. Write it in English. Card titles become branch names.';
  }
  return splitRowProblem({ title });
}

// ─── Accepting several ───────────────────────────────────────────────────────

/** One row of the stack dialog: a candidate and the 0-based stage chosen for it. */
export interface StackRow extends IntakeCandidate {
  stage: number;
}

/**
 * The order the stack dialog opens in: one intake's proposed stack keeps
 * its stages; anything else is one candidate per stage, in the order shown.
 */
export function stackRowsOf(selected: readonly IntakeCandidate[]): StackRow[] {
  const plans = new Set(selected.map((s) => s.plan.id));
  const proposed =
    plans.size === 1 &&
    selected[0]?.plan.intake?.candidateStack &&
    selected.every((s) => s.candidate.stage !== null);
  const rows = selected.map((s, i) => ({
    ...s,
    stage: proposed ? (s.candidate.stage as number) : i,
  }));
  return closeUp(rows);
}

/** Stages are dense and the rows in stage order (as listed inside a stage). */
function closeUp(rows: readonly StackRow[]): StackRow[] {
  const dense = new Map(
    [...new Set(rows.map((r) => r.stage))]
      .sort((a, b) => a - b)
      .map((stage, i) => [stage, i]),
  );
  return rows
    .map((r) => ({ ...r, stage: dense.get(r.stage) as number }))
    .sort((a, b) => a.stage - b.stage);
}

/** A row put in another stage (0-based, up to one stage per row). */
export function setRowStage(
  rows: readonly StackRow[],
  index: number,
  stage: number,
): StackRow[] {
  return closeUp(rows.map((r, i) => (i === index ? { ...r, stage } : r)));
}

/** Up (-1) or down (1): the row trades places — and stages — with its neighbour. */
export function moveRow(
  rows: readonly StackRow[],
  index: number,
  direction: -1 | 1,
): StackRow[] {
  const other = index + direction;
  if (other < 0 || other >= rows.length) return [...rows];
  const next = [...rows];
  const a = next[index];
  const b = next[other];
  next[index] = { ...b, stage: a.stage };
  next[other] = { ...a, stage: b.stage };
  return closeUp(next);
}

/** What the stack makes: each stage, its cards, and the stage it depends on. */
export interface StackPreviewLine {
  stage: number;
  titles: string[];
  dependsOn: number | null;
}

export function stackPreview(rows: readonly StackRow[]): StackPreviewLine[] {
  const count = rows.length === 0 ? 0 : (rows.at(-1) as StackRow).stage + 1;
  return Array.from({ length: count }, (_, stage) => ({
    stage: stage + 1,
    titles: rows.filter((r) => r.stage === stage).map((r) => r.candidate.title),
    dependsOn: stage === 0 ? null : stage,
  }));
}

export const acceptStackRequest = (
  rows: readonly StackRow[],
): AcceptCandidatesRequest => ({
  as: 'stack',
  candidates: rows.map((r) => ({
    id: r.candidate.id,
    version: r.candidate.version,
    stage: r.stage,
  })),
});

/** ADR-0044: the stack gets a shared design when a candidate's intake asked for one. */
export const stackGetsDesign = (
  selected: readonly IntakeCandidate[],
): boolean =>
  selected.some((s) => s.plan.intake?.candidateStack?.design === true);

/**
 * Where the intakes' attachments go (ADR-0037 §4): to the first card
 * accepted from each — or, said for an intake that already gave them, where
 * they went. `first` names the first card of the request ("stage 1").
 */
export function attachmentNotes(
  selected: readonly IntakeCandidate[],
  first: string,
): string[] {
  const plans = [...new Map(selected.map((s) => [s.plan.id, s.plan])).values()];
  return plans.flatMap((plan) => {
    const given = candidatesOf(plan).find(
      (c) => c.attachments > 0 && c.card !== null,
    );
    if (given?.card) {
      return [
        `${draftTitle(plan)} already gave its attachments to ${given.card.label}.`,
      ];
    }
    const left = plan.intake?.attachmentsLeft ?? 0;
    if (left === 0) return [];
    const files = pluralize(left, 'attachment');
    return [
      plans.length === 1
        ? `The intake's ${files} go to ${first}.`
        : `${draftTitle(plan)}'s ${files} go to the first card accepted from it.`,
    ];
  });
}

/** "C-12 is in Todo.", "3 cards are in Todo.", "Stack S-2 is in Todo with 3 cards." */
export function acceptedText(response: AcceptCandidatesResponse): string {
  const n = response.cards.length;
  if (response.stack) {
    return `Stack ${response.stack.label} is in Todo with ${pluralize(n, 'card')}.`;
  }
  return n === 1
    ? `${response.cards[0].label} is in Todo.`
    : `${pluralize(n, 'card')} are in Todo.`;
}

/** A 409 `candidate_decided`: what the candidate became; null for any other error. */
export function candidateDecidedOf(
  error: unknown,
): CandidateDecidedDetails | null {
  if (
    !(error instanceof ApiError) ||
    error.status !== 409 ||
    error.body?.error !== PLANNER_ERROR.candidateDecided
  ) {
    return null;
  }
  const card = error.body.card as CandidateDecidedDetails['card'] | undefined;
  return {
    candidateId: String(error.body.candidateId ?? ''),
    status: error.body.status === 'rejected' ? 'rejected' : 'accepted',
    card: card && typeof card.number === 'number' ? card : null,
  };
}

/** A 409 `candidate_stale`: it was edited in another tab. */
export const isCandidateStale = (error: unknown): boolean =>
  error instanceof ApiError &&
  error.status === 409 &&
  error.body?.error === PLANNER_ERROR.candidateStale;
