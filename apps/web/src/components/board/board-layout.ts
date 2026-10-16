import { useSyncExternalStore } from 'react';

/** The shell's phone breakpoint (the tab bar shows below it). */
export const PHONE_MAX_WIDTH_PX = 768;

/** glass-ui's gap between columns (`gap-3`). */
const COLUMN_GAP = '0.75rem';

/** Narrowest a column gets before the board scrolls sideways instead. */
const MIN_COLUMN = '13.5rem';

/** glass-ui's folded column strip (`--board-column-collapsed`, C-29: 44px). */
const FOLDED_COLUMN = '2.75rem';

/**
 * The `--board-column` width glass-ui's `Board` reads: the `open` columns
 * share what the `folded` strips leave of the scroller exactly, so five fit
 * at 1440 beside the rail; below `MIN_COLUMN` each the board keeps its
 * sideways scroll.
 */
export function boardColumnWidth(open: number, folded = 0): string {
  const n = Math.max(open, 1);
  const strips =
    folded > 0 ? ` - ${folded} * (${FOLDED_COLUMN} + ${COLUMN_GAP})` : '';
  return `max(${MIN_COLUMN}, calc((100%${strips} - ${n - 1} * ${COLUMN_GAP}) / ${n}))`;
}

/** An empty Inbox is dropped on a phone, so the board starts at To Do. */
export function visibleColumns<
  T extends { id: string; cards: readonly unknown[] },
>(columns: readonly T[], phone: boolean): T[] {
  return columns.filter(
    (column) => !(phone && column.id === 'inbox' && column.cards.length === 0),
  );
}

const QUERY = `(max-width: ${PHONE_MAX_WIDTH_PX - 1}px)`;

function subscribe(onChange: () => void): () => void {
  const list = window.matchMedia(QUERY);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

/** True below the phone breakpoint; false on the server. */
export function usePhone(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
