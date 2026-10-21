import { describe, expect, it } from 'bun:test';
import { estimateTokensSaved, estimateUsdSaved } from './estimate';

describe('the estimate (#445 D12)', () => {
  it('is bytes / 4, rounded, never negative', () => {
    expect(estimateTokensSaved(40_000, 3_000)).toBe(9_250);
    expect(estimateTokensSaved(10, 10)).toBe(0);
    expect(estimateTokensSaved(3, 5)).toBe(0);
  });
});

describe('the re-priced estimate (#746 D6, ADR-0074 §5)', () => {
  const prices = { write: '0.00000375', read: '0.0000003' };

  it('is one cache write plus a cache read per remaining turn', () => {
    expect(estimateUsdSaved(10_000, prices, 20)).toBeCloseTo(0.0975, 10);
    // The old pricing — the input price ($3/M) once — gave $0.03.
    expect(10_000 * 0.000003).toBeCloseTo(0.03, 10);
  });

  it('prices at the cache write only with no turns remaining', () => {
    expect(estimateUsdSaved(10_000, prices, 0)).toBeCloseTo(0.0375, 10);
    expect(estimateUsdSaved(10_000, prices, -3)).toBeCloseTo(0.0375, 10);
  });

  it('prices an unpriceable part at 0', () => {
    expect(
      estimateUsdSaved(1_000, { write: 'nope', read: '0.000001' }, 2),
    ).toBeCloseTo(0.002, 10);
    expect(estimateUsdSaved(1_000, { write: '-1', read: '-1' }, 5)).toBe(0);
  });
});
