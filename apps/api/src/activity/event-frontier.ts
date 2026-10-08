/**
 * How far the `events` cursor may move (spec 21 D2, notes). `events.id` comes
 * from a sequence, and two runners' inserts can commit out of id order: a
 * lower id may still appear after a higher one is visible. So the cursor only
 * passes ids it has seen — a hole is waited on, and treated as a rolled-back
 * id once it has stayed open for `graceMs`.
 */
export class EventFrontier {
  /** First missing id of each open hole → when the projector first saw it. */
  private readonly holes = new Map<bigint, number>();

  constructor(private readonly graceMs: number) {}

  /**
   * The highest id the cursor may move to, given the ids above `cursor` in
   * ascending order. `now` is the clock in ms.
   */
  advance(cursor: bigint, ids: readonly bigint[], now: number): bigint {
    let frontier = cursor;
    for (const id of ids) {
      if (id <= frontier) continue;
      const hole = frontier + 1n;
      if (id > hole) {
        const seen = this.holes.get(hole) ?? now;
        if (now - seen < this.graceMs) {
          this.holes.set(hole, seen);
          break;
        }
        this.holes.delete(hole);
      }
      frontier = id;
    }
    for (const hole of this.holes.keys()) {
      if (hole <= frontier) this.holes.delete(hole);
    }
    return frontier;
  }
}
