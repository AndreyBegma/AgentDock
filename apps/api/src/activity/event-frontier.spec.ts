import { EventFrontier } from './event-frontier';

const ids = (...values: number[]) => values.map(BigInt);

describe('EventFrontier (spec 21 D2)', () => {
  it('moves over contiguous ids', () => {
    const frontier = new EventFrontier(10_000);
    expect(frontier.advance(0n, ids(1, 2, 3), 0)).toBe(3n);
    expect(frontier.advance(3n, [], 0)).toBe(3n);
  });

  it('stops before a hole until it fills', () => {
    const frontier = new EventFrontier(10_000);
    expect(frontier.advance(0n, ids(1, 2, 4, 5), 0)).toBe(2n);
    // The slower transaction committed id 3.
    expect(frontier.advance(2n, ids(3, 4, 5), 1_000)).toBe(5n);
  });

  it('skips a hole that stayed open for the grace period', () => {
    const frontier = new EventFrontier(10_000);
    expect(frontier.advance(0n, ids(1, 5, 6), 0)).toBe(1n);
    expect(frontier.advance(1n, ids(5, 6), 9_999)).toBe(1n);
    expect(frontier.advance(1n, ids(5, 6), 10_000)).toBe(6n);
  });

  it('times each hole on its own', () => {
    const frontier = new EventFrontier(10_000);
    expect(frontier.advance(0n, ids(2, 4), 0)).toBe(0n);
    expect(frontier.advance(0n, ids(2, 4), 10_000)).toBe(2n);
    // The hole at 3 was first seen just now.
    expect(frontier.advance(2n, ids(4), 15_000)).toBe(2n);
    expect(frontier.advance(2n, ids(4), 20_000)).toBe(4n);
  });

  it('passes every hole at once with no grace', () => {
    const frontier = new EventFrontier(0);
    expect(frontier.advance(0n, ids(1100, 1102), 0)).toBe(1102n);
  });

  it('a fresh instance (an API restart) waits on a hole again from the stored cursor', () => {
    const before = new EventFrontier(10_000);
    expect(before.advance(0n, ids(1, 3), 0)).toBe(1n);
    const after = new EventFrontier(10_000);
    expect(after.advance(1n, ids(2, 3), 50_000)).toBe(3n);
  });
});
