import { convertLangfusePrices, type LangfuseModel } from './langfuse';
import { compilePattern } from './pricing';
import { readLangfuseSnapshot } from './seed-prices';

/**
 * The usage keys of the vendored snapshot with no bucket, listed in spec 13's
 * notes (AC: the converter's unknown-key report is empty or listed there).
 * A new snapshot with a key not here fails this test until the spec lists it.
 */
const DOCUMENTED_UNKNOWN_KEYS = [
  'cached_content_token_count',
  'candidatesTokenCount',
  'candidates_token_count',
  'groundingQueries',
  'grounding_queries',
  'input_audio',
  'input_audio_tokens',
  'input_cached_audio_tokens',
  'input_cached_text_tokens',
  'input_image',
  'input_modality_1',
  'input_text',
  'input_text_tokens',
  'output_audio',
  'output_audio_tokens',
  'output_modality_1',
  'output_text',
  'output_text_tokens',
  'promptTokenCount',
  'prompt_token_count',
  'thoughtsTokenCount',
  'thoughts_token_count',
  'total',
  'webSearchQueries',
  'web_search_queries',
];

describe('convertLangfusePrices on the vendored snapshot', () => {
  const snapshot = readLangfuseSnapshot();
  const result = convertLangfusePrices(snapshot);

  it('reports only the unknown keys the spec lists', () => {
    expect([...result.unknownKeys.keys()].sort()).toEqual(
      [...DOCUMENTED_UNKNOWN_KEYS].sort(),
    );
  });

  it('finds no conflicting prices between synonym keys', () => {
    expect(result.conflicts).toEqual([]);
  });

  it('keeps every model with a usable default tier, each name once', () => {
    expect(snapshot).toHaveLength(178);
    expect(result.prices.length + result.droppedModels.length).toBe(178);
    const names = result.prices.map((p) => p.modelName);
    expect(new Set(names).size).toBe(names.length);
    for (const price of result.prices) {
      expect(price.tiers.filter((t) => t.isDefault)).toHaveLength(1);
    }
  });

  it('compiles every match pattern as a JavaScript regex', () => {
    for (const price of result.prices) {
      expect(() => compilePattern(price.matchPattern)).not.toThrow();
    }
  });

  it('drops only models priced by modality or as completions/embeddings', () => {
    for (const line of result.droppedModels) {
      expect(line).toMatch(
        /^(text-|textembedding-|gpt-4o-(audio|realtime)|gemini-live)/,
      );
    }
  });
});

describe('convertLangfusePrices', () => {
  const model = (tiers: LangfuseModel['pricingTiers']): LangfuseModel => ({
    modelName: 'm',
    matchPattern: '(?i)^m$',
    pricingTiers: tiers,
  });

  it('maps keys to buckets and prices to plain decimal strings', () => {
    const { prices } = convertLangfusePrices([
      model([
        {
          name: 'Standard',
          isDefault: true,
          priority: 0,
          conditions: [],
          prices: {
            input: 3e-6,
            output: 1.5e-5,
            cache_read_input_tokens: 3e-7,
            input_cache_creation_5m: 3.75e-6,
            input_cache_creation_1h: 6e-6,
            output_reasoning: 1.5e-5,
          },
        },
      ]),
    ]);
    expect(prices[0].tiers[0].prices).toEqual({
      input: '0.000003',
      output: '0.000015',
      cacheRead: '0.0000003',
      cacheWrite5m: '0.00000375',
      cacheWrite1h: '0.000006',
      reasoning: '0.000015',
    });
  });

  it('turns usage-detail thresholds into totalInput and drops request-parameter tiers', () => {
    const result = convertLangfusePrices([
      model([
        {
          name: 'Standard',
          isDefault: true,
          priority: 0,
          conditions: [],
          prices: { input: 1, output: 2 },
        },
        {
          name: 'Fast',
          isDefault: false,
          priority: 1,
          conditions: [
            { source: 'model_parameters', operator: 'in', value: undefined },
          ],
          prices: { input: 5, output: 6 },
        },
        {
          name: 'Long',
          isDefault: false,
          priority: 2,
          conditions: [
            {
              usageDetailPattern: '(input|cache_write)',
              operator: 'gt',
              value: 272000,
            },
          ],
          prices: { input: 3, output: 4 },
        },
      ]),
    ]);
    expect(result.prices[0].tiers.map((t) => t.name)).toEqual([
      'Standard',
      'Long',
    ]);
    expect(result.prices[0].tiers[1].conditions).toEqual([
      { bucket: 'totalInput', op: 'gt', value: 272000 },
    ]);
    expect(result.droppedTiers).toEqual([
      'm: Fast — condition on model_parameters',
    ]);
  });

  it('reports a synonym whose price differs, keeping the primary key', () => {
    const result = convertLangfusePrices([
      model([
        {
          name: 'Standard',
          isDefault: true,
          priority: 0,
          conditions: [],
          prices: { input: 1, input_tokens: 2, output: 3 },
        },
      ]),
    ]);
    expect(result.prices[0].tiers[0].prices.input).toBe('1');
    expect(result.conflicts).toHaveLength(1);
  });
});
