import type {
  BoardCardView,
  BoardView,
  ConfirmSplitCard,
  PlanDetail,
  PlanIntakeSplitView,
  PlanSummary,
  PlanTaskKind,
  PlanTurnView,
} from '@agentdock/shared';
import { CARD_DRAFT_TITLE_MAX } from '@agentdock/shared';
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
  if ([...title].some((ch) => /\p{L}/u.test(ch) && NON_ASCII_LETTER.test(ch))) {
    return 'Write the title in English — cards are stored in English.';
  }
  return null;
}

/** #409: Confirm's body for the rows kept, in their order. */
export const confirmSplitCards = (
  rows: readonly SplitRow[],
): ConfirmSplitCard[] =>
  rows.map((r) => ({ index: r.index, title: r.title.trim(), kind: r.kind }));

/** "Create 3 cards" — Confirm's label. */
export const confirmSplitText = (count: number): string =>
  `Create ${pluralize(count, 'card')}`;

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
      return `split into ${pluralize(phase.split.cards.length, 'card')}?`;
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
