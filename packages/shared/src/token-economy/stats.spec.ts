import { describe, expect, it } from 'bun:test';
import { bootstrapCi, median, NO_INTERVAL, whollyWorse, wilson } from './stats';

describe('wilson (#746 report)', () => {
  it('has no interval over no trials', () => {
    expect(wilson(0, 0)).toEqual(NO_INTERVAL);
  });

  it('matches the textbook interval for 8 of 10', () => {
    const w = wilson(8, 10);
    expect(w.point).toBeCloseTo(0.8, 10);
    expect(w.low).toBeCloseTo(0.4902, 3);
    expect(w.high).toBeCloseTo(0.9433, 3);
  });

  it('stays within [0, 1] at the edges', () => {
    expect(wilson(0, 5).low).toBe(0);
    expect(wilson(5, 5).high).toBe(1);
  });
});

describe('bootstrapCi (#746 report)', () => {
  const mean = (xs: readonly number[]) =>
    xs.reduce((s, x) => s + x, 0) / xs.length;

  it('brackets the point and is reproducible', () => {
    const xs = Array.from({ length: 40 }, (_, i) => (i % 7) + 1);
    const ci = bootstrapCi(xs, mean);
    expect(ci.point).toBeCloseTo(mean(xs), 10);
    expect(ci.low ?? Number.NaN).toBeLessThanOrEqual(ci.point ?? 0);
    expect(ci.high ?? Number.NaN).toBeGreaterThanOrEqual(ci.point ?? 0);
    expect(bootstrapCi(xs, mean)).toEqual(ci);
  });

  it('has no interval when the statistic of the items is null', () => {
    expect(bootstrapCi([], mean)).toEqual(NO_INTERVAL);
    expect(bootstrapCi([1, 2], () => null)).toEqual(NO_INTERVAL);
  });

  it('drops resamples whose statistic is null', () => {
    const cards = [
      { cost: 1, merged: true },
      { cost: 3, merged: false },
    ];
    const ci = bootstrapCi(cards, (sample) => {
      const merged = sample.filter((c) => c.merged).length;
      return merged === 0
        ? null
        : sample.reduce((s, c) => s + c.cost, 0) / merged;
    });
    expect(ci.point).toBe(4);
    expect(ci.low).not.toBeNull();
  });
});

describe('median', () => {
  it('is the middle value, or null for none', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('whollyWorse (#746 worsens)', () => {
  const a = { point: 0.8, low: 0.7, high: 0.9 };

  it('flags a rate whose B interval lies wholly below A', () => {
    expect(whollyWorse(a, { point: 0.5, low: 0.4, high: 0.7 }, true)).toBe(
      true,
    );
    expect(whollyWorse(a, { point: 0.7, low: 0.6, high: 0.85 }, true)).toBe(
      false,
    );
  });

  it('flags a lower-is-better mean whose B interval lies wholly above A', () => {
    const rounds = { point: 2, low: 1.5, high: 2.5 };
    expect(whollyWorse(rounds, { point: 3, low: 2.2, high: 3.5 }, false)).toBe(
      true,
    );
    expect(whollyWorse(rounds, { point: 2.4, low: 1.9, high: 3 }, false)).toBe(
      false,
    );
  });

  it('never flags without data', () => {
    expect(whollyWorse(NO_INTERVAL, a, true)).toBe(false);
    expect(whollyWorse(a, NO_INTERVAL, true)).toBe(false);
  });
});
