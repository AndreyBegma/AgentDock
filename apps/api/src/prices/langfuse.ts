import type {
  ModelPriceInput,
  PriceBucket,
  PriceTier,
  TierCondition,
  TierPrices,
} from '@agentdock/shared';
import { Prisma } from '@prisma/client';

/**
 * Converts Langfuse's `default-model-prices.json` into model prices (spec 13
 * D4). Pure: the seed calls it on the vendored snapshot, and a test runs it on
 * the same file.
 */

/** A Langfuse price-file entry, as far as the conversion reads it. */
export interface LangfuseModel {
  modelName: string;
  matchPattern: string;
  pricingTiers?: LangfuseTier[];
}

interface LangfuseTier {
  name: string;
  isDefault: boolean;
  priority: number;
  conditions: LangfuseCondition[];
  prices: Record<string, number>;
}

interface LangfuseCondition {
  /** Set (to `model_parameters`) on conditions over request parameters. */
  source?: string;
  usageDetailPattern?: string;
  operator: string;
  value?: number;
}

/**
 * Langfuse usage keys → our buckets. Per bucket, the keys of D4 first, then
 * plain synonyms the file also uses (spec 13 notes). When several are present
 * the first one's price wins; a different value under a later key is reported.
 */
export const LANGFUSE_KEY_MAP: Record<PriceBucket, readonly string[]> = {
  input: ['input', 'input_tokens'],
  output: ['output', 'output_tokens'],
  cacheRead: [
    'cache_read_input_tokens',
    'input_cached_tokens',
    'input_cache_read',
  ],
  cacheWrite5m: [
    'input_cache_creation_5m',
    'cache_creation_input_tokens',
    'input_cache_creation',
    'cache_write_tokens',
    'input_cache_write_tokens',
  ],
  cacheWrite1h: ['input_cache_creation_1h'],
  reasoning: [
    'output_reasoning_tokens',
    'output_reasoning',
    'reasoning_tokens',
  ],
};

const KNOWN_KEYS = new Set(Object.values(LANGFUSE_KEY_MAP).flat());

const CONDITION_OPS = new Set(['gt', 'gte', 'lt', 'lte']);

export interface LangfuseConversion {
  prices: ModelPriceInput[];
  /** Usage keys with no bucket, dropped — each with the models that use it. */
  unknownKeys: Map<string, string[]>;
  /** `model: tier — reason` for every tier that could not be expressed. */
  droppedTiers: string[];
  /** `model — reason` for every model left out entirely. */
  droppedModels: string[];
  /** `model/tier: bucket — key=value ignored for key=value`. */
  conflicts: string[];
}

/** A price as a plain decimal string (`3E-7` → `0.0000003`). */
const decimal = (value: number): string =>
  new Prisma.Decimal(String(value)).toFixed();

/**
 * Langfuse's usage-detail conditions match usage keys by regex and sum them;
 * every pattern in the file (`(input|prompt|cached)`, `(input|cache_write)`,
 * `(input)`) selects the input side — all of `totalInput` in our buckets.
 */
const convertCondition = (c: LangfuseCondition): TierCondition | string => {
  if (c.source !== undefined) return `condition on ${c.source}`;
  if (!c.usageDetailPattern || typeof c.value !== 'number') {
    return 'condition without a usage pattern';
  }
  if (!CONDITION_OPS.has(c.operator)) return `operator ${c.operator}`;
  if (!/input/.test(c.usageDetailPattern)) {
    return `usage pattern ${c.usageDetailPattern}`;
  }
  return {
    bucket: 'totalInput',
    op: c.operator as TierCondition['op'],
    value: c.value,
  };
};

export const convertLangfusePrices = (
  models: LangfuseModel[],
): LangfuseConversion => {
  const result: LangfuseConversion = {
    prices: [],
    unknownKeys: new Map(),
    droppedTiers: [],
    droppedModels: [],
    conflicts: [],
  };

  for (const model of models) {
    const tiers: PriceTier[] = [];
    const ordered = [...(model.pricingTiers ?? [])].sort(
      (a, b) => a.priority - b.priority,
    );
    for (const tier of ordered) {
      const conditions: TierCondition[] = [];
      let reason: string | null = null;
      for (const c of tier.conditions) {
        const converted = convertCondition(c);
        if (typeof converted === 'string') {
          reason = converted;
          break;
        }
        conditions.push(converted);
      }
      if (reason !== null) {
        result.droppedTiers.push(
          `${model.modelName}: ${tier.name} — ${reason}`,
        );
        continue;
      }

      for (const key of Object.keys(tier.prices)) {
        if (KNOWN_KEYS.has(key)) continue;
        const users = result.unknownKeys.get(key) ?? [];
        if (!users.includes(model.modelName)) users.push(model.modelName);
        result.unknownKeys.set(key, users);
      }

      const prices: Partial<Record<PriceBucket, string>> = {};
      for (const [bucket, keys] of Object.entries(LANGFUSE_KEY_MAP) as Array<
        [PriceBucket, readonly string[]]
      >) {
        const present = keys.filter((k) => tier.prices[k] !== undefined);
        if (present.length === 0) continue;
        const [first, ...rest] = present;
        prices[bucket] = decimal(tier.prices[first]);
        for (const other of rest) {
          if (decimal(tier.prices[other]) !== prices[bucket]) {
            result.conflicts.push(
              `${model.modelName}/${tier.name}: ${bucket} — ${other}=${tier.prices[other]} ignored for ${first}=${tier.prices[first]}`,
            );
          }
        }
      }
      if (prices.input === undefined || prices.output === undefined) {
        result.droppedTiers.push(
          `${model.modelName}: ${tier.name} — no input or output price`,
        );
        continue;
      }
      tiers.push({
        name: tier.name,
        isDefault: tier.isDefault,
        conditions,
        prices: prices as TierPrices,
      });
    }

    if (!tiers.some((t) => t.isDefault)) {
      result.droppedModels.push(`${model.modelName} — no usable default tier`);
      continue;
    }
    result.prices.push({
      modelName: model.modelName,
      matchPattern: model.matchPattern,
      priority: 0,
      tiers,
    });
  }
  return result;
};
