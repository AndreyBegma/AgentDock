/** An inclusive range of seqs counted as filled: a stored event, or a truncated spool range. */
export type SeqRange = readonly [from: bigint, to: bigint];

/**
 * The highest contiguous seq persisted, starting from `acked` (runner-protocol
 * "Sequence numbers"). A `runner.spool_truncated` range is counted as filled:
 * those events are gone for good, and a cursor stuck below the hole would keep
 * the runner's spool from ever draining ("Delivery guarantees").
 */
export const advanceCursor = (
  acked: bigint,
  filled: Iterable<SeqRange>,
): bigint => {
  const ranges = [...filled]
    .filter(([from, to]) => from <= to && to > acked)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let cursor = acked;
  for (const [from, to] of ranges) {
    if (from > cursor + 1n) break;
    if (to > cursor) cursor = to;
  }
  return cursor;
};
