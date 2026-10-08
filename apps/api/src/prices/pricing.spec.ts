import type { PriceTier } from '@agentdock/shared';
import type { TokenBuckets } from '@agentdock/shared/protocol';
import { convertLangfusePrices } from './langfuse';
import {
  type CompiledPrice,
  compilePattern,
  compilePrices,
  costOf,
  priceRequest,
} from './pricing';
import { readLangfuseSnapshot } from './seed-prices';

const tokens = (t: Partial<TokenBuckets>): TokenBuckets => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  reasoning: 0,
  ...t,
});

describe('pricing against the seeded Langfuse prices (spec 13 AC)', () => {
  let seeded: CompiledPrice[];

  beforeAll(() => {
    seeded = compilePrices(
      convertLangfusePrices(readLangfuseSnapshot()).prices,
    );
  });

  it('prices claude-sonnet-4-5-20250929 to the cent, every bucket', () => {
    // input 3e-6, output 15e-6, cache read 3e-7, 5m write 3.75e-6, 1h write 6e-6:
    // 1200·3e-6 + 850·15e-6 + 40000·3e-7 + 2000·3.75e-6 + 1000·6e-6
    // = 0.0036 + 0.01275 + 0.012 + 0.0075 + 0.006 = 0.04185
    const priced = priceRequest(
      seeded,
      'claude-sonnet-4-5-20250929',
      tokens({
        input: 1200,
        output: 850,
        cacheRead: 40_000,
        cacheWrite5m: 2000,
        cacheWrite1h: 1000,
      }),
    );
    expect(priced?.modelName).toBe('claude-sonnet-4-5-20250929');
    expect(priced?.costUsd.toFixed(6)).toBe('0.041850');
  });

  it('prices gpt-5.3-codex with reasoning counted once, inside output', () => {
    // input 1.75e-6, cached 1.75e-7, output and reasoning 14e-6.
    // output 3000 holds reasoning 2000: 1000 plain + 2000 reasoning.
    // 10000·1.75e-6 + 50000·1.75e-7 + 1000·14e-6 + 2000·14e-6
    // = 0.0175 + 0.00875 + 0.014 + 0.028 = 0.06825 (not 0.09625)
    const priced = priceRequest(
      seeded,
      'gpt-5.3-codex',
      tokens({
        input: 10_000,
        cacheRead: 50_000,
        output: 3000,
        reasoning: 2000,
      }),
    );
    expect(priced?.modelName).toBe('gpt-5.3-codex');
    expect(priced?.costUsd.toFixed(6)).toBe('0.068250');
  });

  it('uses the long-context tier above the threshold, the default at it', () => {
    // claude-haiku-5-5: > 100k input-side tokens → input 5e-7, read 5e-8, output 2.5e-6.
    const long = priceRequest(
      seeded,
      'claude-haiku-5-5',
      tokens({ input: 20_000, cacheRead: 90_000, output: 1000 }),
    );
    expect(long?.tier).toBe('Large Context (>100K)');
    // 20000·5e-7 + 90000·5e-8 + 1000·2.5e-6 = 0.01 + 0.0045 + 0.0025
    expect(long?.costUsd.toFixed(6)).toBe('0.017000');

    const atThreshold = priceRequest(
      seeded,
      'claude-haiku-5-5',
      tokens({ input: 10_000, cacheRead: 90_000, output: 1000 }),
    );
    expect(atThreshold?.tier).toBe('Standard');
    // 10000·1e-7 + 90000·1e-8 + 1000·5e-7 = 0.001 + 0.0009 + 0.0005
    expect(atThreshold?.costUsd.toFixed(6)).toBe('0.002400');
  });

  it('matches case-insensitively and with a provider prefix', () => {
    expect(
      priceRequest(seeded, 'Anthropic/Claude-Sonnet-4-5', tokens({ input: 1 }))
        ?.modelName,
    ).toBe('claude-sonnet-4-5-20250929');
  });

  it('leaves a model no pattern matches unpriced, not zero', () => {
    expect(
      priceRequest(seeded, '<synthetic>', tokens({ input: 5 })),
    ).toBeNull();
    expect(
      priceRequest(seeded, 'my-local-llama', tokens({ input: 5 })),
    ).toBeNull();
  });
});

describe('costOf', () => {
  const tier = (prices: PriceTier['prices']): PriceTier => ({
    name: 't',
    isDefault: true,
    conditions: [],
    prices,
  });

  it('bills reasoning at its own price when one is set', () => {
    const t = tier({ input: '0', output: '0.00001', reasoning: '0.00002' });
    // 500 plain output + 1500 reasoning = 0.005 + 0.03
    expect(
      costOf(t, tokens({ output: 2000, reasoning: 1500 })).toFixed(6),
    ).toBe('0.035000');
  });

  it('falls back: reasoning → output, 1h write → 5m write → input, read → input', () => {
    const t = tier({ input: '0.000001', output: '0.000004' });
    // 100 reasoning at output + 10 read + 10 5m + 10 1h at input
    expect(
      costOf(
        t,
        tokens({
          output: 100,
          reasoning: 100,
          cacheRead: 10,
          cacheWrite5m: 10,
          cacheWrite1h: 10,
        }),
      ).toFixed(6),
    ).toBe('0.000430');
    const with5m = tier({
      input: '0.000001',
      output: '0.000004',
      cacheWrite5m: '0.000002',
    });
    expect(costOf(with5m, tokens({ cacheWrite1h: 10 })).toFixed(6)).toBe(
      '0.000020',
    );
  });

  it('rounds half up to 6 places', () => {
    const t = tier({ input: '0.0000005', output: '0' });
    expect(costOf(t, tokens({ input: 1 })).toFixed(6)).toBe('0.000001');
  });
});

describe('matching order', () => {
  it('takes the lowest priority among matching patterns', () => {
    const t: PriceTier = {
      name: 'Standard',
      isDefault: true,
      conditions: [],
      prices: { input: '1', output: '1' },
    };
    const prices = compilePrices([
      { modelName: 'broad', matchPattern: '^claude', priority: 10, tiers: [t] },
      {
        modelName: 'exact',
        matchPattern: '^claude-x$',
        priority: 1,
        tiers: [t],
      },
    ]);
    expect(priceRequest(prices, 'claude-x', tokens({}))?.modelName).toBe(
      'exact',
    );
    expect(priceRequest(prices, 'claude-y', tokens({}))?.modelName).toBe(
      'broad',
    );
  });

  it('drops a leading (?i) and refuses an invalid regex', () => {
    expect(compilePattern('(?i)^GPT-5$').test('gpt-5')).toBe(true);
    expect(() => compilePattern('(')).toThrow(SyntaxError);
  });
});
