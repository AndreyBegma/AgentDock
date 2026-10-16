import {
  type BoardCardView,
  type BoardColumn,
  type BoardStackView,
  type BoardView,
  isStackGated,
  stackStageText,
  stageName,
} from '@agentdock/shared';
import { formatCost } from '../format';
import type { BoardItem } from './format';
import type { WorkBoardItem } from './plan-tasks';

/**
 * Stacks on the Board (#480, ADR-0044): a stack is one collapsed face in the
 * column of its least advanced unfinished card. The cards of the stack that
 * sit in that column fold into the face; a card of the stack in another
 * column stays on its own, wearing its stack's label.
 */

/** The id prefix that keeps a stack apart from a card id in glass-ui's `Board`. */
const STACK_ITEM_PREFIX = 'stack:';

/** One stack as glass-ui's `Board` takes it: not draggable, no move entries. */
export interface StackItem {
  id: string;
  label: string;
  movable: false;
  stack: BoardStackView;
  /** Every card of the stack the board holds, by number. */
  cards: BoardCardView[];
  /** The ids of the cards folded into the face, in column order. */
  foldedIds: string[];
}

/** Everything a column shows: a card, a plan task, or a stack. */
export type ColumnItem = WorkBoardItem | StackItem;

export const isStackItem = (item: ColumnItem): item is StackItem =>
  'stack' in item && !('card' in item);

/** The items that are not stacks — what selection and moves work on. */
export const withoutStacks = (items: readonly ColumnItem[]): WorkBoardItem[] =>
  items.filter((item): item is WorkBoardItem => !isStackItem(item));

/** Every card the board holds, by number. */
const cardsOf = (view: BoardView): Map<number, BoardCardView> =>
  new Map(
    view.columns.flatMap((c) => c.cards.map((card) => [card.number, card])),
  );

/**
 * A column's items with each stack that sits in it folded in: its cards in
 * the column are taken out, and the stack's face takes the place of the
 * first of them — the top of the column when none is shown (a fully
 * accepted stack whose cards are on an older Completed page). A stack whose
 * cards the filter hid altogether is not shown while filtering.
 */
export function foldStacks(
  items: readonly WorkBoardItem[],
  column: BoardColumn,
  view: BoardView,
  filtering: boolean,
): ColumnItem[] {
  const stacks = (view.stacks ?? []).filter((s) => s.column === column);
  if (stacks.length === 0) return [...items];
  const byNumber = cardsOf(view);
  const out: ColumnItem[] = [...items];
  for (const stack of stacks) {
    const numbers = new Set(stack.stages.flatMap((s) => s.cards));
    const folded = out.filter(
      (item): item is BoardItem =>
        !isStackItem(item) && 'card' in item && numbers.has(item.card.number),
    );
    const at = folded.length > 0 ? out.indexOf(folded[0]) : 0;
    if (filtering && folded.length === 0) continue;
    const item: StackItem = {
      id: `${STACK_ITEM_PREFIX}${stack.id}`,
      label: `${stack.label} ${stack.title}`,
      movable: false,
      stack,
      cards: [...numbers]
        .map((n) => byNumber.get(n))
        .filter((c): c is BoardCardView => c !== undefined),
      foldedIds: folded.map((f) => f.id),
    };
    const kept = out.filter((x) => !folded.includes(x as BoardItem));
    kept.splice(Math.min(at, kept.length), 0, item);
    out.splice(0, out.length, ...kept);
  }
  return out;
}

/** "1 of 5 accepted". */
export const stackProgressText = (stack: BoardStackView): string =>
  `${stack.accepted} of ${stack.total} accepted`;

/** The stack face's current stage, as `stackStageText` says it. */
export const stackStage = stackStageText;

/** "Stack · 5 cards". */
export const stackKindText = (stack: BoardStackView): string =>
  `Stack · ${stack.total} card${stack.total === 1 ? '' : 's'}`;

/** The cost on a stack face; null when nothing is priced. */
export const stackCost = (stack: BoardStackView): string | null =>
  formatCost(stack.costUsd);

/** The face's design chip: only while the design holds the stack. */
export const stackDesignChip = (stack: BoardStackView): string | null =>
  isStackGated(stack.design) ? 'Stack design not approved' : null;

/** One stage of an expanded face: its name, its cards and how many are accepted. */
export interface StackStageGroup {
  position: number;
  name: string;
  cards: BoardCardView[];
  accepted: number;
  /** Numbers of stage cards the board does not hold (an older Completed page). */
  missing: number[];
}

export function stackStages(item: StackItem): StackStageGroup[] {
  const byNumber = new Map(item.cards.map((c) => [c.number, c]));
  return item.stack.stages.map((stage) => {
    const cards = stage.cards
      .map((n) => byNumber.get(n))
      .filter((c): c is BoardCardView => c !== undefined);
    return {
      position: stage.position,
      name: stageName(stage.position, stage.title),
      cards,
      // A card the board does not hold is on an older Completed page.
      accepted:
        cards.filter((c) => c.column === 'completed').length +
        stage.cards.filter((n) => !byNumber.has(n)).length,
      missing: stage.cards.filter((n) => !byNumber.has(n)),
    };
  });
}
