import type {
  BoardCardView,
  BoardView,
  ConfirmSplitCard,
  ConfirmSplitRequest,
  PlanCandidateView,
  PlanDetail,
  PlanIntakeSplitView,
  PlanSummary,
  PlanTaskKind,
  PlanTurnView,
} from '@agentdock/shared';
import {
  CARD_DRAFT_TITLE_MAX,
  INTAKE_SPLIT_MAX,
  STACK_STAGE_TITLE_MAX,
  STACK_TITLE_MAX,
} from '@agentdock/shared';
import { pluralize } from '../format';
import { activeTurn, failedTurn } from '../planner/format';

/**
 * New work is an interview (#337 D2–D6, #409): a `card`-mode plan whose
 * turns open question rounds until the model writes the card — or proposes
 * to split the request into several. These helpers say where an intake
 * stands — for its dialog and for the Drafts strip.
 */

/** What to do, as typed: the API's brief limit (`BRIEF_MAX_LENGTH`). */
export const INTAKE_BRIEF_MAX = 20_000;

export type IntakePhase =
  /** A turn is queued or running: the model is reading or writing. */
  | { kind: 'thinking'; turn: PlanTurnView }
  /** The last turn failed: Retry. */
  | { kind: 'failed'; turn: PlanTurnView }
  /** A round is open. `round` is 1-based. */
  | { kind: 'round'; round: number; maxRounds: number }
  /** #409: the intake proposes several cards; the person confirms or declines. */
  | { kind: 'split'; split: PlanIntakeSplitView }
  /** #592 (ADR-0055): the cards wait in Drafts as candidates to accept or reject. */
  | { kind: 'review'; candidates: PlanCandidateView[] }
  /** The cards exist; `cards` are those the board shows so far. */
  | { kind: 'done'; cards: BoardCardView[] }
  /** Discarded (archived) or sent: no card will come. */
  | { kind: 'closed' }
  /** Nothing open and nothing running: only Enough — generate moves it on. */
  | { kind: 'idle' };

/**
 * The board cards a plan made: their origin (`planId`, #337 D6) — one, or
 * every card of a confirmed split (#409) — by number, the order they were
 * made in.
 */
export const cardsOfPlan = (
  view: BoardView | undefined,
  planId: string,
): BoardCardView[] =>
  (view?.columns ?? [])
    .flatMap((column) => column.cards.filter((c) => c.planId === planId))
    .sort((a, b) => a.number - b.number);

export function intakePhase(plan: PlanDetail, board?: BoardView): IntakePhase {
  if (plan.status === 'done') {
    return { kind: 'done', cards: cardsOfPlan(board, plan.id) };
  }
  if (plan.status === 'archived' || plan.status === 'sent') {
    return { kind: 'closed' };
  }
  if (plan.status === 'reviewing') {
    return { kind: 'review', candidates: plan.intake?.candidates ?? [] };
  }
  const active = activeTurn(plan);
  if (active) return { kind: 'thinking', turn: active };
  const failed = failedTurn(plan.turns, null);
  if (failed) return { kind: 'failed', turn: failed };
  if (plan.questions.length > 0) {
    const asked = plan.intake?.roundsAsked ?? 1;
    return {
      kind: 'round',
      round: Math.max(asked, 1),
      maxRounds: plan.intake?.maxRounds ?? asked,
    };
  }
  if (plan.intake?.split) return { kind: 'split', split: plan.intake.split };
  return { kind: 'idle' };
}

/** #409: one row of the split the person edits before Confirm. */
export interface SplitRow {
  index: number;
  title: string;
  kind: PlanTaskKind;
  summary: string;
}

/** #409: the proposal as editable rows, in its order. */
export const splitRows = (split: PlanIntakeSplitView): SplitRow[] =>
  split.cards.map((c) => ({ ...c }));

const NON_ASCII_LETTER = /[^\p{ASCII}]/u;

const hasNonAsciiLetter = (text: string): boolean =>
  [...text].some((ch) => /\p{L}/u.test(ch) && NON_ASCII_LETTER.test(ch));

/**
 * #409: why a row cannot be confirmed — the API's rule, said before the
 * round trip: a title, at most `CARD_DRAFT_TITLE_MAX` characters, in English
 * (no letter outside ASCII). Null when it can.
 */
export function splitRowProblem(row: Pick<SplitRow, 'title'>): string | null {
  const title = row.title.trim();
  if (title === '') return 'A card needs a title.';
  if (title.length > CARD_DRAFT_TITLE_MAX) {
    return `At most ${CARD_DRAFT_TITLE_MAX} characters.`;
  }
  if (hasNonAsciiLetter(title)) {
    return 'Write the title in English — cards are stored in English.';
  }
  return null;
}

/** #409: Confirm's body for the rows kept, in their order. */
export const confirmSplitCards = (
  rows: readonly SplitRow[],
): ConfirmSplitCard[] =>
  rows.map((r) => ({ index: r.index, title: r.title.trim(), kind: r.kind }));

/** "Send 3 cards to Drafts" — Confirm's label (#592: they wait there as candidates). */
export const confirmSplitText = (count: number): string =>
  `Send ${pluralize(count, 'card')} to Drafts`;

// ─── Stacks (#480, ADR-0044) ─────────────────────────────────────────────────

/** How the person confirms the proposal: independent cards, or one stack. */
export type ProposalShape = 'split' | 'stack';

/** One stage of the stack being reviewed: its name and its cards by index. */
export interface StageDraft {
  title: string;
  cards: number[];
}

/** The stack being reviewed, beside the rows (titles, kinds) it orders. */
export interface StackDraft {
  title: string;
  body: string;
  design: boolean;
  stages: StageDraft[];
}

/** The shape the review opens in: whatever the intake proposed. */
export const proposedShape = (split: PlanIntakeSplitView): ProposalShape =>
  split.stack ? 'stack' : 'split';

/**
 * #524: what the split view says about its cards — they are independent, so
 * UI cards for one surface, which share one look, belong in a stack.
 */
export const SPLIT_HINT =
  'Independent cards: no stages, no shared design, no dependencies between them. UI changes to one surface share one look — switch to Stack to give them one design.';

/**
 * The stack the review starts from: the intake's, or — for a split the
 * person turns into a stack — staged foundations first (#524, ADR-0044 §3):
 * an empty "Foundations" stage for the shared pieces the person moves up,
 * every card in "Features", and one shared design of the whole result.
 */
export function stackDraft(split: PlanIntakeSplitView): StackDraft {
  if (split.stack) {
    return {
      title: split.stack.title,
      body: split.stack.body,
      design: split.stack.design,
      stages: split.stack.stages.map((s) => ({
        title: s.title,
        cards: [...s.cards],
      })),
    };
  }
  return {
    title: '',
    body: '',
    design: true,
    stages: [
      { title: 'Foundations', cards: [] },
      { title: 'Features', cards: split.cards.map((c) => c.index) },
    ],
  };
}

/** The stage a card is in now; -1 when it was removed. */
export const stageOf = (draft: StackDraft, index: number): number =>
  draft.stages.findIndex((s) => s.cards.includes(index));

/**
 * Moves a card to the stage before (`-1`) or after (`1`) its own; a card
 * already at the edge stays.
 */
export function moveToStage(
  draft: StackDraft,
  index: number,
  direction: -1 | 1,
): StackDraft {
  const from = stageOf(draft, index);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= draft.stages.length) return draft;
  return {
    ...draft,
    stages: draft.stages.map((stage, i) =>
      i === from
        ? { ...stage, cards: stage.cards.filter((c) => c !== index) }
        : i === to
          ? { ...stage, cards: [...stage.cards, index] }
          : stage,
    ),
  };
}

/** A new, empty last stage named "Stage N"; at most one per card. */
export function addStage(draft: StackDraft): StackDraft {
  if (draft.stages.length >= INTAKE_SPLIT_MAX) return draft;
  return {
    ...draft,
    stages: [
      ...draft.stages,
      { title: `Stage ${draft.stages.length + 1}`, cards: [] },
    ],
  };
}

/** The card is removed from the proposal: it leaves its stage too. */
export const dropFromStages = (
  draft: StackDraft,
  index: number,
): StackDraft => ({
  ...draft,
  stages: draft.stages.map((s) => ({
    ...s,
    cards: s.cards.filter((c) => c !== index),
  })),
});

/**
 * Why the stack cannot be confirmed — the API's rules, said first: a title
 * in English, English stage names, and at least one stage with a card.
 * Null when it can.
 */
export function stackProblem(draft: StackDraft): string | null {
  const title = draft.title.trim();
  if (title === '') return 'A stack needs a title.';
  if (title.length > STACK_TITLE_MAX) {
    return `At most ${STACK_TITLE_MAX} characters.`;
  }
  if (hasNonAsciiLetter(title)) {
    return 'Write the title in English — stacks are stored in English.';
  }
  const named = draft.stages.find(
    (s) => s.title.length > STACK_STAGE_TITLE_MAX || hasNonAsciiLetter(s.title),
  );
  if (named) return 'Stage names are short and in English.';
  if (draft.stages.every((s) => s.cards.length === 0)) {
    return 'A stack needs a card in a stage.';
  }
  return null;
}

/**
 * Confirm's body for the reviewed proposal: the kept rows in their order —
 * stage order for a stack — and, for a stack, its stages without the empty
 * ones.
 */
export function confirmRequest(
  turnId: string,
  shape: ProposalShape,
  rows: readonly SplitRow[],
  draft: StackDraft,
): ConfirmSplitRequest {
  if (shape === 'split') {
    return { turnId, cards: confirmSplitCards(rows) };
  }
  const kept = new Set(rows.map((r) => r.index));
  const stages = draft.stages
    .map((s) => ({
      title: s.title.trim(),
      cards: s.cards.filter((c) => kept.has(c)),
    }))
    .filter((s) => s.cards.length > 0);
  const order = stages.flatMap((s) => s.cards);
  const byIndex = new Map(rows.map((r) => [r.index, r]));
  return {
    turnId,
    cards: confirmSplitCards(
      order.map((i) => byIndex.get(i)).filter((r): r is SplitRow => !!r),
    ),
    stack: {
      title: draft.title.trim(),
      body: draft.body.trim(),
      design: draft.design,
      stages,
    },
  };
}

/** "Send stack to Drafts · 5 cards", or a split's "Send 3 cards to Drafts". */
export const confirmText = (shape: ProposalShape, count: number): string =>
  shape === 'stack'
    ? `Send stack to Drafts · ${pluralize(count, 'card')}`
    : confirmSplitText(count);

/**
 * The line beside Confirm: #592, the cards wait in Drafts — nothing reaches
 * To Do until the person accepts it — and what holds them once accepted.
 */
export const confirmHint = (shape: ProposalShape, design: boolean): string =>
  shape === 'split'
    ? 'They wait in Drafts until you accept them.'
    : design
      ? 'They wait in Drafts; once accepted, Run waits for the stack design.'
      : 'They wait in Drafts; once accepted, stages depend on each other.';

/** "The planner proposes a stack of 5 cards in 2 stages". */
export function proposalTitle(split: PlanIntakeSplitView): string {
  const cards = pluralize(split.cards.length, 'card');
  return split.stack
    ? `The planner proposes a stack of ${cards} in ${pluralize(split.stack.stages.length, 'stage')}`
    : `The planner proposes ${cards}`;
}

/** "Round 2 of at most 4". */
export const roundText = (round: number, maxRounds: number): string =>
  `Round ${round} of at most ${maxRounds}`;

/** The strip loads each draft's detail, so it shows the newest few. */
export const DRAFTS_SHOWN_MAX = 8;

/**
 * An open draft (#337 D2): the person's own New work intake that has not
 * made its cards, or their own plan still being shaped (one started before
 * New Plan went away, #409) — so closing the dialog or the panel never
 * loses it. Newest first.
 */
export function openDrafts(
  plans: readonly PlanSummary[],
  userId: string,
): PlanSummary[] {
  return plans
    .filter(
      (p) =>
        p.author.id === userId &&
        p.status !== 'done' &&
        p.status !== 'sent' &&
        p.status !== 'sending' &&
        p.status !== 'archived',
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** A draft's state on the strip, from its detail; null while the detail loads. */
export function draftStateText(plan: PlanDetail | undefined): string | null {
  if (!plan) return null;
  if (plan.mode !== 'card') {
    if (activeTurn(plan)) return 'thinking…';
    if (failedTurn(plan.turns, null)) return 'failed — retry';
    if (plan.tasks.length > 0) return pluralize(plan.tasks.length, 'task');
    return plan.questions.length > 0
      ? `${pluralize(plan.questions.length, 'question')} waiting`
      : 'open';
  }
  const phase = intakePhase(plan);
  switch (phase.kind) {
    case 'thinking':
      return 'thinking…';
    case 'failed':
      return 'failed — retry';
    case 'round':
      return `${pluralize(plan.questions.length, 'question')} waiting`;
    case 'split':
      return phase.split.stack
        ? `stack of ${pluralize(phase.split.cards.length, 'card')}?`
        : `split into ${pluralize(phase.split.cards.length, 'card')}?`;
    case 'review': {
      const pending = phase.candidates.filter((c) => c.status === 'pending');
      return `${pluralize(pending.length, 'card')} to review`;
    }
    case 'idle':
      return 'ready to generate';
    case 'done':
      return 'card created';
    case 'closed':
      return 'closed';
  }
}

/** What a draft is called on the strip: its title, else its brief's start. */
export const draftTitle = (plan: Pick<PlanSummary, 'title'>): string =>
  plan.title.trim() || 'Untitled';
