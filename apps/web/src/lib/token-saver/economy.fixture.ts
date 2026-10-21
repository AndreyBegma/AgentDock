import {
  NO_INTERVAL,
  type TokenEconomyArmReport,
  type TokenEconomyReport,
  type TokenEconomyTechniqueReport,
} from '@nautelle/shared';

/** Test data for the #746 report: one arm with every figure present. */
export const armFixture = (
  arm: 'a' | 'b',
  over: Partial<TokenEconomyArmReport> = {},
): TokenEconomyArmReport => ({
  arm,
  settledCards: 40,
  mergedCards: 32,
  forcedCards: 0,
  costPerSuccessUsd: { point: 1.2, low: 0.9, high: 1.6 },
  medianMergedCostUsd: 0.95,
  signals: {
    greenFirstPush: { point: 0.62, low: 0.48, high: 0.74 },
    rounds: { point: 3.1, low: 2.6, high: 3.7 },
    noReviewReturns: { point: 0.8, low: 0.66, high: 0.89 },
    noRetries: { point: 0.9, low: 0.77, high: 0.96 },
  },
  ...over,
});

export const techniqueFixture = (
  over: Partial<TokenEconomyTechniqueReport> = {},
): TokenEconomyTechniqueReport => ({
  technique: 'read-guard',
  label: 'Read guard',
  mode: 'ab',
  a: armFixture('a'),
  b: armFixture('b', { costPerSuccessUsd: { point: 0.8, low: 0.6, high: 1 } }),
  enoughData: true,
  worsens: [],
  ...over,
});

export const reportFixture = (
  techniques: TokenEconomyTechniqueReport[] = [techniqueFixture()],
): TokenEconomyReport => ({
  from: '2026-09-21T00:00:00.000Z',
  to: '2026-10-21T00:00:00.000Z',
  bSharePercent: 50,
  minCardsPerArm: 30,
  techniques,
});

/** An arm with no settled card yet. */
export const emptyArmFixture = (arm: 'a' | 'b'): TokenEconomyArmReport =>
  armFixture(arm, {
    settledCards: 0,
    mergedCards: 0,
    costPerSuccessUsd: NO_INTERVAL,
    medianMergedCostUsd: null,
    signals: {
      greenFirstPush: NO_INTERVAL,
      rounds: NO_INTERVAL,
      noReviewReturns: NO_INTERVAL,
      noRetries: NO_INTERVAL,
    },
  });
