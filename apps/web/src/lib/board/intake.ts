import type {
  BoardCardView,
  BoardView,
  PlanDetail,
  PlanSummary,
  PlanTurnView,
} from '@agentdock/shared';
import { pluralize } from '../format';
import { activeTurn, failedTurn } from '../planner/format';

/**
 * New Card is an interview (#337 D2–D6): a `card`-mode plan whose turns
 * open question rounds until the model writes the card. These helpers say
 * where an intake stands — for its dialog and for the Drafts strip.
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
  /** The card exists; `card` once the board shows it. */
  | { kind: 'done'; card: BoardCardView | null }
  /** Discarded (archived) or sent: no card will come. */
  | { kind: 'closed' }
  /** Nothing open and nothing running: only Enough — generate moves it on. */
  | { kind: 'idle' };

/** The board card a plan made: its origin (`planId`, #337 D6). */
export const cardOfPlan = (
  view: BoardView | undefined,
  planId: string,
): BoardCardView | null => {
  for (const column of view?.columns ?? []) {
    const card = column.cards.find((c) => c.planId === planId);
    if (card) return card;
  }
  return null;
};

export function intakePhase(plan: PlanDetail, board?: BoardView): IntakePhase {
  if (plan.status === 'done') {
    return { kind: 'done', card: cardOfPlan(board, plan.id) };
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
  return { kind: 'idle' };
}

/** "Round 2 of at most 4". */
export const roundText = (round: number, maxRounds: number): string =>
  `Round ${round} of at most ${maxRounds}`;

/** The strip loads each draft's detail, so it shows the newest few. */
export const DRAFTS_SHOWN_MAX = 8;

/**
 * An open draft (#337 D2): the person's own intake that has not made its
 * card, or their own New Plan still being shaped — so closing the dialog
 * or the panel never loses it. Newest first.
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
