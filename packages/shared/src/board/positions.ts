/**
 * D3: order inside a column is a fractional index (`position Float`). The
 * Board reports a drop as `{ toColumnId, index }`; the position is computed
 * from the neighbours at that index, so a move writes one row.
 */

/** The gap between neighbours at the ends of a column, and after a rebalance. */
export const BOARD_POSITION_STEP = 1024;

/**
 * The position for a card dropped at `index` of a column whose other cards
 * (the moving card excluded) have `positions`, sorted ascending. `index` is
 * clamped to the column. `null` when the neighbours are too close for a
 * double to hold a value between them: rebalance the column first
 * (`rebalancedPositions`), then ask again.
 */
export const positionForIndex = (
  positions: readonly number[],
  index: number,
): number | null => {
  const at = Math.min(Math.max(Math.trunc(index), 0), positions.length);
  const before = at > 0 ? positions[at - 1] : undefined;
  const after = at < positions.length ? positions[at] : undefined;
  if (before === undefined && after === undefined) return 0;
  if (before === undefined) return (after as number) - BOARD_POSITION_STEP;
  if (after === undefined) return before + BOARD_POSITION_STEP;
  const mid = before + (after - before) / 2;
  return mid > before && mid < after ? mid : null;
};

/** Evenly spaced positions for a column of `count` cards, in order. */
export const rebalancedPositions = (count: number): number[] =>
  Array.from({ length: count }, (_, i) => i * BOARD_POSITION_STEP);
