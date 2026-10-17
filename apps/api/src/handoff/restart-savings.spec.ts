import { Pricer } from '../prices/cost.service';
import { compilePrices } from '../prices/pricing';
import { restartSavedUsd } from './restart-savings';

/** $15 / M input, $1.50 / M cache read. */
const pricer = new Pricer(
  1,
  compilePrices([
    {
      modelName: 'claude-opus-4',
      matchPattern: '^claude-opus-4$',
      priority: 0,
      tiers: [
        {
          name: 'default',
          isDefault: true,
          conditions: [],
          prices: {
            input: '0.000015',
            output: '0.000075',
            cacheRead: '0.0000015',
          },
        },
      ],
    },
  ]),
);

describe('restartSavedUsd (#449 D9, ADR-0009)', () => {
  it('prices a cold history as uncached input against the fresh seed', () => {
    // 200k × $15/M − 10k × $15/M = $3.00 − $0.15
    expect(
      restartSavedUsd(pricer, 'claude-opus-4', {
        resumeTokens: 200_000,
        freshTokens: 10_000,
        cacheWarm: false,
      }),
    ).toBe('2.850000');
  });

  it('prices a warm history as a cache read', () => {
    // 200k × $1.50/M − 10k × $15/M = $0.30 − $0.15
    expect(
      restartSavedUsd(pricer, 'claude-opus-4', {
        resumeTokens: 200_000,
        freshTokens: 10_000,
        cacheWarm: true,
      }),
    ).toBe('0.150000');
  });

  it('is null when nothing was saved or the model is unpriced', () => {
    const estimate = {
      resumeTokens: 10_000,
      freshTokens: 20_000,
      cacheWarm: false,
    };
    expect(restartSavedUsd(pricer, 'claude-opus-4', estimate)).toBeNull();
    expect(
      restartSavedUsd(pricer, 'claude-opus-4', {
        ...estimate,
        freshTokens: 10_000,
      }),
    ).toBeNull();
    expect(
      restartSavedUsd(pricer, 'gpt-5', { ...estimate, resumeTokens: 1e6 }),
    ).toBeNull();
  });
});
