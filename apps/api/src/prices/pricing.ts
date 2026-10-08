import type {
  ConditionSubject,
  ModelPriceInput,
  PriceBucket,
  PriceTier,
  TierCondition,
} from '@agentdock/shared';
import type { TokenBuckets } from '@agentdock/shared/protocol';
import { Prisma } from '@prisma/client';

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

/** `llm_requests.costUsd` is Decimal(14, 6). */
export const COST_SCALE = 6;

/** A model price with its pattern compiled, ready to match. */
export interface CompiledPrice {
  modelName: string;
  pattern: RegExp;
  priority: number;
  tiers: PriceTier[];
}

export interface PricedRequest {
  modelName: string;
  tier: string;
  /** Rounded to `COST_SCALE` places. */
  costUsd: Decimal;
}

/**
 * Compiles a match pattern case-insensitively (D3). A leading `(?i)` — the
 * PCRE flag Langfuse writes — is dropped, since JavaScript has no inline flags.
 * Throws a `SyntaxError` on an invalid regex.
 */
export const compilePattern = (pattern: string): RegExp =>
  new RegExp(pattern.replace(/^\(\?i\)/, ''), 'i');

/** Ordered for matching: lowest `priority` first, then by name for a stable tie-break. */
export const compilePrices = (models: ModelPriceInput[]): CompiledPrice[] =>
  models
    .map((m) => ({
      modelName: m.modelName,
      pattern: compilePattern(m.matchPattern),
      priority: m.priority,
      tiers: m.tiers,
    }))
    .sort(
      (a, b) =>
        a.priority - b.priority || a.modelName.localeCompare(b.modelName),
    );

export const matchModel = (
  prices: CompiledPrice[],
  model: string,
): CompiledPrice | null => prices.find((p) => p.pattern.test(model)) ?? null;

const subjectValue = (
  tokens: TokenBuckets,
  subject: ConditionSubject,
): number =>
  subject === 'totalInput'
    ? tokens.input +
      tokens.cacheRead +
      tokens.cacheWrite5m +
      tokens.cacheWrite1h
    : tokens[subject];

const holds = (tokens: TokenBuckets, c: TierCondition): boolean => {
  const v = subjectValue(tokens, c.bucket);
  switch (c.op) {
    case 'gt':
      return v > c.value;
    case 'gte':
      return v >= c.value;
    case 'lt':
      return v < c.value;
    case 'lte':
      return v <= c.value;
  }
};

/** The first non-default tier whose conditions all hold, else the default tier (D3). */
export const selectTier = (
  tiers: PriceTier[],
  tokens: TokenBuckets,
): PriceTier | null => {
  const conditional = tiers.find(
    (t) =>
      !t.isDefault &&
      t.conditions.length > 0 &&
      t.conditions.every((c) => holds(tokens, c)),
  );
  return conditional ?? tiers.find((t) => t.isDefault) ?? null;
};

/**
 * The price of one bucket, with the fallbacks of the spec notes: reasoning is
 * billed as output (D5); a cache write without its own price as the 5-minute
 * write, then as input; a cache read without one as input.
 */
export const bucketPrice = (tier: PriceTier, bucket: PriceBucket): string => {
  const p = tier.prices;
  switch (bucket) {
    case 'input':
      return p.input;
    case 'output':
      return p.output;
    case 'reasoning':
      return p.reasoning ?? p.output;
    case 'cacheRead':
      return p.cacheRead ?? p.input;
    case 'cacheWrite5m':
      return p.cacheWrite5m ?? p.input;
    case 'cacheWrite1h':
      return p.cacheWrite1h ?? p.cacheWrite5m ?? p.input;
  }
};

/**
 * `Σ bucket × price` (D6). Reasoning tokens are inside `output` (spec 12), so
 * output is billed for `output − reasoning` and reasoning at its own price —
 * every token once.
 */
export const costOf = (tier: PriceTier, tokens: TokenBuckets): Decimal => {
  const plainOutput = Math.max(tokens.output - tokens.reasoning, 0);
  const counts: Record<PriceBucket, number> = {
    input: tokens.input,
    output: plainOutput,
    cacheRead: tokens.cacheRead,
    cacheWrite5m: tokens.cacheWrite5m,
    cacheWrite1h: tokens.cacheWrite1h,
    reasoning: Math.min(tokens.reasoning, tokens.output),
  };
  let total = new Decimal(0);
  for (const bucket of Object.keys(counts) as PriceBucket[]) {
    if (counts[bucket] === 0) continue;
    total = total.add(
      new Decimal(bucketPrice(tier, bucket)).mul(counts[bucket]),
    );
  }
  return total.toDecimalPlaces(COST_SCALE, Decimal.ROUND_HALF_UP);
};

/** The cost of a request, or null when no model price matches its model (unpriced). */
export const priceRequest = (
  prices: CompiledPrice[],
  model: string,
  tokens: TokenBuckets,
): PricedRequest | null => {
  const match = matchModel(prices, model);
  if (!match) return null;
  const tier = selectTier(match.tiers, tokens);
  if (!tier) return null;
  return {
    modelName: match.modelName,
    tier: tier.name,
    costUsd: costOf(tier, tokens),
  };
};
