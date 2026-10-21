import type { ArmCard } from './token-economy-report.service';
import { armReport, verdictOf } from './token-economy-report.service';

const card = (over: Partial<ArmCard> = {}): ArmCard => ({
  technique: 'fixture',
  arm: 'a',
  mode: 'ab',
  settled: true,
  merged: true,
  cost: 1,
  greenFirstPush: true,
  rounds: 1,
  noReviewReturns: true,
  retries: 0,
  ...over,
});

const many = (n: number, over: Partial<ArmCard> = {}) =>
  Array.from({ length: n }, () => card(over));

describe('armReport (#746 D1, D3)', () => {
  it('counts only settled cards and prices $/successful card over merged ones', () => {
    const report = armReport('a', [
      card({ cost: 2 }),
      card({ cost: 4, merged: false }),
      card({ settled: false, merged: false, cost: 100 }),
    ]);
    expect(report.settledCards).toBe(2);
    expect(report.mergedCards).toBe(1);
    // (2 + 4) / 1: the failed card counts against the arm.
    expect(report.costPerSuccessUsd.point).toBe(6);
    expect(report.medianMergedCostUsd).toBe(2);
  });

  it('gives each signal a point and an interval', () => {
    const report = armReport('b', [
      card({ arm: 'b', mode: 'on', greenFirstPush: false, rounds: 3 }),
      card({ arm: 'b', retries: 2, noReviewReturns: false }),
    ]);
    expect(report.forcedCards).toBe(1);
    expect(report.signals.greenFirstPush.point).toBe(0.5);
    expect(report.signals.noRetries.point).toBe(0.5);
    expect(report.signals.noReviewReturns.point).toBe(0.5);
    expect(report.signals.rounds.point).toBe(2);
    for (const s of Object.values(report.signals)) {
      expect(s.low).not.toBeNull();
      expect(s.high).not.toBeNull();
    }
  });

  it('has no cost per success without a merged card', () => {
    const report = armReport('a', [card({ merged: false })]);
    expect(report.costPerSuccessUsd.point).toBeNull();
    expect(report.medianMergedCostUsd).toBeNull();
  });
});

describe('verdictOf (#746 enoughData, worsens)', () => {
  it('is not enough data below the threshold in either arm', () => {
    const a = armReport('a', many(30));
    expect(verdictOf(a, armReport('b', many(29))).enoughData).toBe(false);
    expect(verdictOf(a, armReport('b', many(30))).enoughData).toBe(true);
  });

  it('lists a signal whose B interval lies wholly on the worse side', () => {
    const a = armReport('a', many(40));
    const b = armReport('b', [
      ...many(30, { greenFirstPush: false, rounds: 3 }),
      ...many(10),
    ]);
    const { worsens } = verdictOf(a, b);
    expect(worsens).toEqual(['greenFirstPush', 'rounds']);
  });

  it('lists nothing when B is as good as A', () => {
    const a = armReport('a', many(40));
    expect(verdictOf(a, armReport('b', many(40))).worsens).toEqual([]);
  });
});
