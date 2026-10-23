import { CARD_PR_HEAD_LAG_MS } from '@nautelle/shared';
import { prHeadBehind } from './board-shipping';

const OLD = 'a'.repeat(40);
const PUSHED = 'b'.repeat(40);
const NOW = Date.parse('2026-10-23T17:21:00.000Z');

/** #895: the PR GitHub shows lags behind the head the round pushed. */
describe('prHeadBehind (#895)', () => {
  const round = (extra: {
    startHeadSha?: string | null;
    headSha?: string | null;
    finishedAt?: Date | null;
  }) => ({
    startHeadSha: OLD,
    headSha: PUSHED,
    finishedAt: new Date(NOW - 60_000),
    ...extra,
  });

  it('is behind while the PR shows the head the round started from, not its push', () => {
    expect(prHeadBehind(round({}), OLD, NOW)).toBe(true);
    expect(prHeadBehind(round({ finishedAt: null }), OLD, NOW)).toBe(true);
  });

  it('is not behind once the PR shows the pushed head', () => {
    expect(prHeadBehind(round({}), PUSHED, NOW)).toBe(false);
  });

  it('is not behind for a round that pushed nothing, or no round', () => {
    expect(prHeadBehind(round({ headSha: null }), OLD, NOW)).toBe(false);
    expect(prHeadBehind(null, OLD, NOW)).toBe(false);
  });

  it('is not behind when the PR shows a third head', () => {
    expect(prHeadBehind(round({}), 'c'.repeat(40), NOW)).toBe(false);
    expect(prHeadBehind(round({ startHeadSha: null }), OLD, NOW)).toBe(false);
  });

  it('takes the PR as it is once the lag has passed since the round ended', () => {
    const ended = new Date(NOW - CARD_PR_HEAD_LAG_MS);
    expect(prHeadBehind(round({ finishedAt: ended }), OLD, NOW)).toBe(false);
  });
});
