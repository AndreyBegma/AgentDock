import {
  type BoardCardView,
  type BulkBoardCardsResponse,
  type BulkCardAction,
  type BulkCardFacts,
  type BulkCardOutcome,
  type BulkCardSkipReason,
  bulkCardRule,
} from '@nautelle/shared';
import { isSuggestion } from './format';
import { isPlanItem, type WorkBoardItem } from './plan-tasks';

/** Card numbers, across columns (#452). */
export type CardSelection = ReadonlySet<number>;

export const NO_SELECTION: CardSelection = new Set();

/** Plan tasks follow their plan; Inbox suggestions are accepted or dismissed one by one. */
export const isSelectable = (item: WorkBoardItem): boolean =>
  !isPlanItem(item) && !isSuggestion(item.card);

/** The numbers a column offers to select, in the order it shows them. */
export const selectableNumbers = (items: readonly WorkBoardItem[]): number[] =>
  items.flatMap((item) =>
    !isPlanItem(item) && isSelectable(item) ? [item.card.number] : [],
  );

export const toggled = (
  selection: CardSelection,
  number: number,
): CardSelection => {
  const next = new Set(selection);
  if (!next.delete(number)) next.add(number);
  return next;
};

/**
 * Shift+click: every card from the last clicked one to this one, inside one
 * column (`order`), added to the selection. Without an anchor in this column
 * it selects the card alone.
 */
export const withRange = (
  selection: CardSelection,
  order: readonly number[],
  anchor: number | null,
  target: number,
): CardSelection => {
  const to = order.indexOf(target);
  const from = anchor === null ? -1 : order.indexOf(anchor);
  const next = new Set(selection);
  if (to === -1) return next;
  if (from === -1) {
    next.add(target);
    return next;
  }
  for (const n of order.slice(Math.min(from, to), Math.max(from, to) + 1)) {
    next.add(n);
  }
  return next;
};

export interface ColumnSelection {
  selected: number;
  total: number;
  state: 'none' | 'some' | 'all';
}

/** How much of a column's selectable cards (`order`: those the filter shows) is selected. */
export const columnSelection = (
  order: readonly number[],
  selection: CardSelection,
): ColumnSelection => {
  const selected = order.filter((n) => selection.has(n)).length;
  const state =
    selected === 0 ? 'none' : selected === order.length ? 'all' : 'some';
  return { selected, total: order.length, state };
};

/** "Select all": all of `order`, or, when they all are selected already, none of them. */
export const toggledColumn = (
  selection: CardSelection,
  order: readonly number[],
): CardSelection => {
  const next = new Set(selection);
  const all = order.length > 0 && order.every((n) => selection.has(n));
  for (const n of order) {
    if (all) next.delete(n);
    else next.add(n);
  }
  return next;
};

export const withAll = (
  selection: CardSelection,
  order: readonly number[],
): CardSelection => new Set([...selection, ...order]);

/** A selected card that left the board drops out; the same set when none did. */
export const pruned = (
  selection: CardSelection,
  onBoard: ReadonlySet<number>,
): CardSelection => {
  if ([...selection].every((n) => onBoard.has(n))) return selection;
  return new Set([...selection].filter((n) => onBoard.has(n)));
};

export const bulkFacts = (card: BoardCardView): BulkCardFacts => ({
  column: card.column,
  roundPhase: card.round?.phase ?? null,
  source: card.source,
  autoCollect: card.autoCollect,
  // The same reading as the API's: no slot to follow, or the slot is gone.
  slotGone: card.fleet === null || card.fleet.slotGone,
  trackingAlive: card.tracking?.alive === true,
});

export interface BulkPlan {
  /** The cards the action applies to — "N of M". */
  applies: BoardCardView[];
  skipped: { card: BoardCardView; reason: BulkCardSkipReason }[];
}

export const planBulk = (
  action: BulkCardAction,
  cards: readonly BoardCardView[],
): BulkPlan => {
  const plan: BulkPlan = { applies: [], skipped: [] };
  for (const card of cards) {
    const decision = bulkCardRule(action, bulkFacts(card));
    if (decision.applies) plan.applies.push(card);
    else plan.skipped.push({ card, reason: decision.reason });
  }
  return plan;
};

/** Cards whose pull request is still open (or a draft): Completed leaves it so. */
export const openPullRequests = (cards: readonly BoardCardView[]): number =>
  cards.filter(
    (card) =>
      card.prNumber !== null &&
      (card.prState === 'open' || card.prState === 'draft'),
  ).length;

export const BULK_ACTION_LABEL: Record<BulkCardAction, string> = {
  complete: 'Move to Completed',
  todo: 'Move to To Do',
  finished: 'Mark finished',
  delete: 'Delete',
};

/** Why a card is left out of a bulk action, in a few words. */
export const BULK_SKIP_TEXT: Record<BulkCardSkipReason, string> = {
  card_running: 'running',
  automatic_to_completed: 'only a person completes a card',
  card_completed: 'completed',
  invalid_move: 'a suggestion',
  plan_task_derived: 'a plan task',
  fleet_slot: 'its fleet slot owns the move',
  already_in_column: 'already there',
  wrong_column: 'not finished',
  not_running: 'not running',
  not_found: 'gone',
};

const DONE_TEXT: Record<BulkCardAction, string> = {
  complete: 'moved to Completed',
  todo: 'moved to To Do',
  finished: 'marked finished',
  delete: 'deleted',
};

const cards = (n: number): string => `${n} card${n === 1 ? '' : 's'}`;

/**
 * The one toast of a bulk action: what was done, and what was skipped with
 * why, grouped by reason. `warn` while anything was skipped or failed.
 */
export function summarizeBulk(
  response: BulkBoardCardsResponse,
  labelOf: (number: number) => string,
): { text: string; warn: boolean } {
  const done = response.results.filter((r) => r.status === 'done').length;
  const groups = new Map<string, string[]>();
  for (const r of response.results) {
    if (r.status === 'done') continue;
    const why = r.status === 'skipped' ? BULK_SKIP_TEXT[r.reason] : r.message;
    groups.set(why, [...(groups.get(why) ?? []), labelOf(r.number)]);
  }
  const left = response.results.length - done;
  const head = `${cards(done)} ${DONE_TEXT[response.action]}.`;
  if (left === 0) {
    return {
      text:
        response.action === 'complete'
          ? `${head} No pull request was merged or closed.`
          : head,
      warn: false,
    };
  }
  const detail = [...groups]
    .map(([why, labels]) => `${labels.join(', ')}: ${why}`)
    .join('; ');
  return {
    text: `${head} ${left} left alone — ${detail}. They stay selected.`,
    warn: true,
  };
}

/** What stays selected after a bulk action: every card that was not done. */
export const leftAfter = (results: readonly BulkCardOutcome[]): CardSelection =>
  new Set(results.filter((r) => r.status !== 'done').map((r) => r.number));

/** The requests a selection takes: the API takes `BULK_CARDS_MAX` numbers at a time. */
export const inBatches = <T>(items: readonly T[], size: number): T[][] => {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
};

/** How many of `selected` the action applies to: "40 of 42". */
export const appliesLabel = (applies: number, selected: number): string =>
  `${applies} of ${selected}`;
