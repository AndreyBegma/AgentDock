import { describe, expect, test } from 'bun:test';
import type {
  TokenSaverCostPerRound,
  TokenSaverFilterSavings,
  TokenSaverSummary,
} from '@agentdock/shared';
import {
  costChange,
  costPerRoundTrends,
  emptySummary,
  mergeSummaries,
  mostPassedThrough,
  promptCacheTotals,
  runnerTooOldForReasons,
  savingsChartSeries,
  topFilters,
  unfilteredReasons,
} from './summary';

const FROM = '2026-10-01T00:00:00.000Z';
const TO = '2026-11-01T00:00:00.000Z';

const filter = (
  name: string,
  usd: number,
  commands = 10,
  passedThrough = 0,
): TokenSaverFilterSavings => ({
  filter: name,
  estimateUsd: usd,
  estimateTokens: usd * 1000,
  commands,
  bypassed: 0,
  passedThrough,
});

const summary = (over: Partial<TokenSaverSummary>): TokenSaverSummary => ({
  ...emptySummary(FROM, TO),
  ...over,
});

describe('mergeSummaries', () => {
  test('nothing merges to an empty summary with zero rates', () => {
    const merged = mergeSummaries([], FROM, TO);
    expect(merged.totals.commands).toBe(0);
    expect(merged.bypassRate).toBe(0);
    expect(merged.byFilter).toEqual([]);
  });

  test('adds totals, days, filters and run kinds across projects', () => {
    const a = summary({
      pivotAt: '2026-10-05T00:00:00.000Z',
      totals: {
        estimateUsd: 1,
        estimateTokens: 1000,
        commands: 10,
        rawBytes: 4000,
        keptBytes: 1000,
      },
      bypassRate: 0.1,
      passThroughRate: 0.2,
      byDay: [{ day: '2026-10-05', estimateUsd: 1, estimateTokens: 1000 }],
      byFilter: [filter('js/jest', 1)],
      byRunKind: [
        { runKind: 'card', estimateUsd: 1, estimateTokens: 1000, commands: 10 },
      ],
    });
    const b = summary({
      pivotAt: '2026-10-02T00:00:00.000Z',
      totals: {
        estimateUsd: 2,
        estimateTokens: 2000,
        commands: 30,
        rawBytes: 8000,
        keptBytes: 2000,
      },
      bypassRate: 0.3,
      passThroughRate: 0,
      byDay: [
        { day: '2026-10-04', estimateUsd: 0.5, estimateTokens: 500 },
        { day: '2026-10-05', estimateUsd: 1.5, estimateTokens: 1500 },
      ],
      byFilter: [filter('js/jest', 2), filter('ops/git', 0.5)],
      byRunKind: [
        { runKind: 'card', estimateUsd: 2, estimateTokens: 2000, commands: 30 },
      ],
    });
    const merged = mergeSummaries([a, b], FROM, TO);
    expect(merged.totals.estimateUsd).toBe(3);
    expect(merged.totals.commands).toBe(40);
    expect(merged.totals.rawBytes).toBe(12000);
    expect(merged.pivotAt).toBe('2026-10-02T00:00:00.000Z');
    // (0.1·10 + 0.3·30) / 40
    expect(merged.bypassRate).toBeCloseTo(0.25);
    expect(merged.passThroughRate).toBeCloseTo(0.05);
    expect(merged.byDay.map((d) => d.day)).toEqual([
      '2026-10-04',
      '2026-10-05',
    ]);
    expect(merged.byDay[1]?.estimateUsd).toBe(2.5);
    expect(
      merged.byFilter.map((f) => [f.filter, f.estimateUsd, f.commands]),
    ).toEqual([
      ['js/jest', 3, 20],
      ['ops/git', 0.5, 10],
    ]);
    expect(merged.byRunKind).toEqual([
      { runKind: 'card', estimateUsd: 3, estimateTokens: 3000, commands: 40 },
    ]);
  });

  test('before/after averages are weighted by their runs', () => {
    const row = (beforeRuns: number, before: string, afterRuns: number) => ({
      runKind: 'card' as const,
      beforeRuns,
      beforeAvgUsd: before,
      afterRuns,
      afterAvgUsd: afterRuns > 0 ? '0.50' : null,
    });
    const merged = mergeSummaries(
      [
        summary({ beforeAfter: [row(1, '1.00', 2)] }),
        summary({ beforeAfter: [row(3, '2.00', 0)] }),
      ],
      FROM,
      TO,
    );
    const [only] = merged.beforeAfter;
    expect(merged.beforeAfter).toHaveLength(1);
    expect(Number(only?.beforeAvgUsd)).toBeCloseTo(1.75);
    expect(only?.beforeRuns).toBe(4);
    expect(Number(only?.afterAvgUsd)).toBeCloseTo(0.5);
    expect(only?.afterRuns).toBe(2);
  });

  test('a side with no priced run stays null', () => {
    const merged = mergeSummaries(
      [
        summary({
          beforeAfter: [
            {
              runKind: 'plan',
              beforeRuns: 0,
              beforeAvgUsd: null,
              afterRuns: 0,
              afterAvgUsd: null,
            },
          ],
        }),
      ],
      FROM,
      TO,
    );
    expect(merged.beforeAfter[0]?.beforeAvgUsd).toBeNull();
    expect(merged.beforeAfter[0]?.afterAvgUsd).toBeNull();
  });
});

describe('mergeSummaries (#648)', () => {
  test('adds programs and the prompt cache; the runner version is dropped', () => {
    const a = summary({
      unfilteredPrograms: [
        { program: 'git log', commands: 3 },
        { program: 'ls', commands: 1 },
      ],
      promptCache: [
        { runKind: 'card', runs: 2, input: 10, cacheRead: 80, cacheWrite: 10 },
      ],
      runnerVersion: '0.12.2',
    });
    const b = summary({
      unfilteredPrograms: [
        { program: 'ls', commands: 4 },
        ...Array.from({ length: 10 }, (_, i) => ({
          program: `tool${i}`,
          commands: 1,
        })),
      ],
      promptCache: [
        { runKind: 'card', runs: 1, input: 5, cacheRead: 5, cacheWrite: 0 },
        { runKind: 'skill', runs: 1, input: 1, cacheRead: 0, cacheWrite: 0 },
      ],
    });
    const merged = mergeSummaries([a, b], FROM, TO);
    expect(merged.unfilteredPrograms).toHaveLength(10);
    expect(merged.unfilteredPrograms.slice(0, 3)).toEqual([
      { program: 'ls', commands: 5 },
      { program: 'git log', commands: 3 },
      { program: 'tool0', commands: 1 },
    ]);
    expect(merged.promptCache).toEqual([
      { runKind: 'card', runs: 3, input: 15, cacheRead: 85, cacheWrite: 10 },
      { runKind: 'skill', runs: 1, input: 1, cacheRead: 0, cacheWrite: 0 },
    ]);
    expect(merged.runnerVersion).toBeNull();
  });
});

describe('unfilteredReasons (#648)', () => {
  test('one row per reason, legacy `none` last, with its share', () => {
    expect(
      unfilteredReasons([
        filter('js/jest', 1),
        filter('none', 0, 2),
        filter('none:uncovered', 0, 4),
        filter('none:off', 0, 2),
      ]),
    ).toEqual([
      { filter: 'none:compound', commands: 0, share: 0 },
      { filter: 'none:uncovered', commands: 4, share: 0.5 },
      { filter: 'none:mode', commands: 0, share: 0 },
      { filter: 'none:off', commands: 2, share: 0.25 },
      { filter: 'none', commands: 2, share: 0.25 },
    ]);
  });

  test('all five rows at zero with nothing unfiltered', () => {
    expect(unfilteredReasons([]).map((r) => r.commands)).toEqual([
      0, 0, 0, 0, 0,
    ]);
  });
});

const week = (
  sessionKind: TokenSaverCostPerRound['sessionKind'],
  weekOf: string,
  medianUsd: string | null,
): TokenSaverCostPerRound => ({
  sessionKind,
  week: weekOf,
  rounds: 3,
  pricedRounds: medianUsd === null ? 0 : 3,
  medianUsd,
  p90Usd: medianUsd,
  cacheReadShare: 0.9,
  medianPeakContext: 120_000,
  medianTurns: 14,
});

describe('costPerRoundTrends (#663 D5)', () => {
  test('per kind, the newest week against the oldest, in the summary’s kind order', () => {
    const trends = costPerRoundTrends([
      week('card', '2026-10-05', '2.000000'),
      week('card', '2026-10-12', '1.800000'),
      week('card', '2026-10-19', '1.300000'),
      week('ci_fix', '2026-10-19', '0.500000'),
    ]);
    expect(trends.map((t) => t.sessionKind)).toEqual(['card', 'ci_fix']);
    expect(trends[0]?.latest.week).toBe('2026-10-19');
    expect(trends[0]?.earliest?.week).toBe('2026-10-05');
    expect(trends[0]?.change).toBeCloseTo(-0.35);
    // One week: nothing to compare against.
    expect(trends[1]).toMatchObject({ earliest: null, change: null });
  });

  test('no change when either median is unpriced', () => {
    const [trend] = costPerRoundTrends([
      week('design', '2026-10-05', null),
      week('design', '2026-10-12', '1.000000'),
    ]);
    expect(trend?.change).toBeNull();
  });

  test('a sum of projects has no cost per round — medians do not add', () => {
    const one = summary({
      costPerRound: [week('card', '2026-10-12', '1.000000')],
    });
    expect(mergeSummaries([one, one], FROM, TO).costPerRound).toEqual([]);
  });
});

describe('runnerTooOldForReasons (#648)', () => {
  test('an old runner whose rows carry no reason', () => {
    expect(
      runnerTooOldForReasons(
        summary({ runnerVersion: '0.12.2', byFilter: [filter('none', 0)] }),
      ),
    ).toBe(true);
  });

  test('not for a newer or unknown runner, nor one that already sends reasons', () => {
    expect(runnerTooOldForReasons(summary({ runnerVersion: '0.13.0' }))).toBe(
      false,
    );
    expect(runnerTooOldForReasons(summary({ runnerVersion: null }))).toBe(
      false,
    );
    expect(
      runnerTooOldForReasons(
        summary({
          runnerVersion: '0.12.2',
          byFilter: [filter('none:compound', 0)],
        }),
      ),
    ).toBe(false);
  });
});

describe('promptCacheTotals (#648)', () => {
  test('sums every run kind', () => {
    expect(
      promptCacheTotals([
        { runKind: 'card', runs: 2, input: 10, cacheRead: 80, cacheWrite: 10 },
        { runKind: 'plan', runs: 1, input: 5, cacheRead: 5, cacheWrite: 0 },
      ]),
    ).toEqual({ runs: 3, input: 15, cacheRead: 85, cacheWrite: 10 });
  });
});

describe('topFilters', () => {
  test('most saved first, uncovered commands left out, limited', () => {
    const top = topFilters(
      [
        filter('b', 1),
        filter('none', 9),
        filter('none:compound', 9),
        filter('none:uncovered', 9),
        filter('none:mode', 9),
        filter('a', 3),
        filter('c', 2),
      ],
      2,
    );
    expect(top.map((f) => f.filter)).toEqual(['a', 'c']);
  });
});

describe('mostPassedThrough (D13)', () => {
  test('ranks by share, then count, and omits filters that never passed through', () => {
    const ranked = mostPassedThrough(
      [
        filter('never', 5, 10, 0),
        filter('some', 1, 10, 3),
        filter('half', 1, 4, 2),
        filter('none', 0, 20, 20),
        filter('big', 1, 100, 50),
      ],
      10,
    );
    expect(ranked.map((f) => f.filter)).toEqual([
      'none',
      'big',
      'half',
      'some',
    ]);
  });
});

describe('savingsChartSeries', () => {
  test('one bar per day at its UTC midnight', () => {
    const [series] = savingsChartSeries([
      { day: '2026-10-05', estimateUsd: 1.5, estimateTokens: 1500 },
    ]);
    expect(series?.points).toEqual([
      { x: Date.parse('2026-10-05T00:00:00Z'), y: 1.5 },
    ]);
  });
});

describe('costChange', () => {
  const row = (before: string | null, after: string | null) => ({
    runKind: 'card' as const,
    beforeRuns: 1,
    beforeAvgUsd: before,
    afterRuns: 1,
    afterAvgUsd: after,
  });

  test('is the relative change from before to after', () => {
    expect(costChange(row('2.00', '1.50'))).toBeCloseTo(-0.25);
  });

  test('is null when a side is missing or before is not positive', () => {
    expect(costChange(row(null, '1'))).toBeNull();
    expect(costChange(row('1', null))).toBeNull();
    expect(costChange(row('0', '1'))).toBeNull();
  });
});
