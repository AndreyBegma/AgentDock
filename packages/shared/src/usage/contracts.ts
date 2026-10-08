import type { Runtime, TokenBuckets } from '../protocol';

// ─── Price table (docs/specs/13 D2, D3) ─────────────────────────────────────

/** The token buckets a price can be set for — the six of `llm_requests` (D1). */
export const PRICE_BUCKETS = [
  'input',
  'output',
  'cacheRead',
  'cacheWrite5m',
  'cacheWrite1h',
  'reasoning',
] as const;
export type PriceBucket = (typeof PRICE_BUCKETS)[number];

/** `totalInput`: input + cacheRead + cacheWrite5m + cacheWrite1h — the context size. */
export const CONDITION_SUBJECTS = [...PRICE_BUCKETS, 'totalInput'] as const;
export type ConditionSubject = (typeof CONDITION_SUBJECTS)[number];

export const CONDITION_OPS = ['gt', 'gte', 'lt', 'lte'] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export interface TierCondition {
  bucket: ConditionSubject;
  op: ConditionOp;
  value: number;
}

/**
 * USD per token, per bucket, as a decimal string. A bucket without a price
 * falls back (D5, spec notes): reasoning → output; cacheWrite1h → cacheWrite5m
 * → input; cacheRead → input. `input` and `output` are required.
 */
export type TierPrices = Partial<Record<PriceBucket, string>> & {
  input: string;
  output: string;
};

/**
 * The first tier whose conditions all hold applies, in array order; when none
 * does, the `isDefault` one (exactly one per model price).
 */
export interface PriceTier {
  name: string;
  isDefault: boolean;
  conditions: TierCondition[];
  prices: TierPrices;
}

/**
 * `matchPattern` is a regex tested case-insensitively against the request's
 * model id; when several match, the lowest `priority` wins.
 */
export interface ModelPriceInput {
  modelName: string;
  matchPattern: string;
  priority: number;
  tiers: PriceTier[];
}

export const PRICE_SOURCES = ['langfuse-seed', 'admin'] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

export interface PriceVersionSummary {
  id: string;
  number: number;
  source: PriceSource;
  note: string | null;
  createdBy: { id: string; email: string } | null;
  createdAt: string;
  models: number;
}

/** `GET /admin/prices` — the current version; null before the seed ran. */
export interface CurrentPricesResponse {
  version: PriceVersionSummary | null;
  models: ModelPriceInput[];
}

export interface PriceVersionListResponse {
  versions: PriceVersionSummary[];
}

/** `POST /admin/prices/versions` — clone the current version, apply the edits. */
export interface CreatePriceVersionRequest {
  note: string;
  upsert: ModelPriceInput[];
  remove: string[];
}

/** `POST /admin/prices/test` — which price applies to a model id and usage. */
export interface PriceTestRequest {
  model: string;
  tokens: Partial<TokenBuckets>;
}

export interface PriceTestResponse {
  version: number | null;
  /** null: no pattern matches — the request would be unpriced. */
  modelName: string | null;
  tier: string | null;
  costUsd: string | null;
}

export const RECOMPUTE_STATUSES = [
  'queued',
  'running',
  'done',
  'failed',
] as const;
export type RecomputeStatus = (typeof RECOMPUTE_STATUSES)[number];

/** `POST /admin/prices/recompute` — re-price requests with `from <= ts < to`. */
export interface RecomputeRequest {
  from: string;
  to: string;
  versionId: string;
}

export interface RecomputeProgress {
  id: string;
  versionId: string;
  versionNumber: number;
  from: string;
  to: string;
  status: RecomputeStatus;
  processed: number;
  total: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** Stable codes in the `error` field of a usage or price route's error body. */
export const USAGE_ERROR = {
  /** The `projectId` filtered on does not exist or is not visible (D9). */
  notFound: 'not_found',
  /** `from` not before `to`, an unknown time zone, a range too long. */
  invalidRange: 'invalid_range',
  /** A match pattern that is not a valid regex; tiers without one default. */
  invalidPrice: 'invalid_price',
  /** A recompute is already queued or running (D7). */
  recomputeRunning: 'recompute_running',
} as const;
export type UsageErrorCode = (typeof USAGE_ERROR)[keyof typeof USAGE_ERROR];

export interface UsageErrorBody {
  statusCode: number;
  error: UsageErrorCode;
  message: string;
}

// ─── Usage (docs/specs/13 API) ──────────────────────────────────────────────

/**
 * Token buckets, request count, cost, and how many requests have no price.
 * `costUsd` is a decimal string over the priced requests only; unpriced
 * requests are counted, never valued at zero (D6).
 */
export interface UsageTotals extends TokenBuckets {
  requests: number;
  unpricedRequests: number;
  costUsd: string;
}

/** `from`/`to`: ISO instants, `to` exclusive. Without `projectId`: every visible project. */
export interface UsageRangeQuery {
  from: string;
  to: string;
  projectId?: string;
}

export interface UsageSummaryResponse {
  totals: UsageTotals;
  byRuntime: Array<UsageTotals & { runtime: Runtime }>;
}

export const USAGE_INTERVALS = ['hour', 'day'] as const;
export type UsageInterval = (typeof USAGE_INTERVALS)[number];

export const USAGE_GROUP_BY = ['none', 'project', 'model', 'runtime'] as const;
export type UsageGroupBy = (typeof USAGE_GROUP_BY)[number];

export interface UsageTimeseriesQuery extends UsageRangeQuery {
  interval?: UsageInterval;
  groupBy?: UsageGroupBy;
  /** IANA zone the `day` interval is cut in; default `UTC` (D10). */
  tz?: string;
}

/**
 * `tokens` counts every token once: input + output + cacheRead + cacheWrite5m
 * + cacheWrite1h (reasoning is inside output).
 */
export interface UsagePoint {
  t: string;
  costUsd: string;
  tokens: number;
  requests: number;
  unpricedRequests: number;
}

export interface UsageSeries {
  /** The group's key — project id, model, runtime; null for `none` or no project. */
  key: string | null;
  label: string | null;
  points: UsagePoint[];
}

export interface UsageTimeseriesResponse {
  interval: UsageInterval;
  groupBy: UsageGroupBy;
  tz: string;
  series: UsageSeries[];
}

export const USAGE_DIMENSIONS = [
  'project',
  'model',
  'runtime',
  'issue',
  'slot',
  'run',
] as const;
export type UsageDimension = (typeof USAGE_DIMENSIONS)[number];

export const USAGE_BREAKDOWN_DEFAULT_LIMIT = 20;
export const USAGE_BREAKDOWN_MAX_LIMIT = 200;

export interface UsageBreakdownQuery extends UsageRangeQuery {
  dimension: UsageDimension;
  limit?: number;
}

export interface UsageBreakdownRow extends UsageTotals {
  /** The dimension's value as a string; null when absent (no project, no slot…). */
  key: string | null;
  /** Display name: the project's name for `project`, else the key. */
  label: string | null;
  /** The project a `slot` / `issue` / `run` row belongs to. */
  projectId: string | null;
}

export interface UsageBreakdownResponse {
  dimension: UsageDimension;
  rows: UsageBreakdownRow[];
}
