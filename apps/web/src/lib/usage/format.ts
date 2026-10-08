import {
  type ModelPriceInput,
  type PriceTier,
  USAGE_ERROR,
  type UsageDimension,
  type UsageInterval,
  type UsageRangeQuery,
} from '@agentdock/shared';
import { ApiError, describeError } from '../api';

export const RANGE_PRESETS = ['24h', '7d', '30d', 'custom'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const PRESET_MS = { '24h': DAY_MS, '7d': 7 * DAY_MS, '30d': 30 * DAY_MS };

export interface UsageRange {
  from: string;
  to: string;
}

/** `to` is exclusive; a preset ends at the start of the next hour so "now" is included. */
export function presetRange(
  preset: Exclude<RangePreset, 'custom'>,
  now: Date = new Date(),
): UsageRange {
  const to = Math.ceil((now.getTime() + 1) / HOUR_MS) * HOUR_MS;
  return {
    from: new Date(to - PRESET_MS[preset]).toISOString(),
    to: new Date(to).toISOString(),
  };
}

/**
 * Two `yyyy-mm-dd` dates (both inclusive, the browser's local days) → an
 * instant range; null while either is missing or the order is wrong.
 */
export function customRange(
  fromDate: string,
  toDate: string,
): UsageRange | null {
  if (!fromDate || !toDate || fromDate > toDate) return null;
  const from = new Date(`${fromDate}T00:00:00`);
  const to = new Date(`${toDate}T00:00:00`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  to.setDate(to.getDate() + 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Hours fit a day or two; longer ranges read better per day. */
export function intervalFor(range: UsageRange): UsageInterval {
  const span = Date.parse(range.to) - Date.parse(range.from);
  return span <= 2 * DAY_MS ? 'hour' : 'day';
}

export function rangeQuery(
  range: UsageRange,
  projectId: string,
  extra: Record<string, string | number | undefined> = {},
): string {
  const query: UsageRangeQuery & Record<string, string | number | undefined> = {
    from: range.from,
    to: range.to,
    ...extra,
  };
  if (projectId) query.projectId = projectId;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  return `?${params.toString()}`;
}

/** The viewer's IANA zone, falling back to UTC. */
export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function timeZones(): string[] {
  const zones: string[] = ['UTC'];
  try {
    for (const zone of Intl.supportedValuesOf('timeZone')) {
      if (zone !== 'UTC') zones.push(zone);
    }
  } catch {
    // An engine without supportedValuesOf: UTC and the browser's zone only.
    const own = browserZone();
    if (own !== 'UTC') zones.push(own);
  }
  return zones;
}

/** Blank when there is no price at all — never `$0.00` for an unpriced figure. */
export function formatUsd(costUsd: string | null): string {
  if (costUsd === null) return '';
  const value = Number(costUsd);
  if (!Number.isFinite(value)) return '';
  if (value === 0) return '$0.00';
  if (value < 0.01) return '<$0.01';
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * The cost of a group whose requests may all be unpriced: nothing priced and
 * something unpriced means "no figure", not zero.
 */
export function costOrBlank(
  costUsd: string,
  requests: number,
  unpricedRequests: number,
): string {
  if (requests > 0 && unpricedRequests >= requests) return '';
  return formatUsd(costUsd);
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  const trim = (v: number) =>
    v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '');
  if (n < 1_000_000) return `${trim(n / 1_000)}k`;
  if (n < 1_000_000_000) return `${trim(n / 1_000_000)}M`;
  return `${trim(n / 1_000_000_000)}B`;
}

export const DIMENSION_LABEL: Record<UsageDimension, string> = {
  project: 'Project',
  model: 'Model',
  runtime: 'Runtime',
  issue: 'Issue',
  slot: 'Slot',
  run: 'Run',
};

/** The breakdowns the page offers: `run` has no data until runs exist (spec 13 note 3). */
export const BREAKDOWN_DIMENSIONS = [
  'project',
  'model',
  'runtime',
  'issue',
  'slot',
] as const satisfies readonly UsageDimension[];

/** A breakdown row's label; an absent value is named, not left empty. */
export function groupLabel(
  dimension: UsageDimension,
  label: string | null,
  key: string | null,
): string {
  const text = label ?? key;
  if (text) return dimension === 'issue' ? `#${text}` : text;
  return dimension === 'project' ? 'No project (machine-wide)' : 'None';
}

export function formatDay(iso: string, interval: UsageInterval): string {
  const date = new Date(iso);
  return interval === 'hour'
    ? date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const formatTime = (iso: string): string =>
  new Date(iso).toLocaleString();

export function describeUsageError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'That project was not found.';
    if (error.status === 403) return 'You do not have access to this.';
    if (error.status === 409) {
      return 'A recompute is already running. Wait for it to finish.';
    }
    if (error.status === 400) return error.message;
  }
  return describeError(error);
}

/** Server error body codes arrive in `ApiError.code`; typed narrowly for auth only. */
export const isRecomputeRunning = (error: unknown): boolean =>
  error instanceof ApiError &&
  (error.status === 409 ||
    (error.code as string | undefined) === USAGE_ERROR.recomputeRunning);

/* ── prices ─────────────────────────────────────────────────────────── */

const MILLION = 1_000_000;

/** USD per token (decimal string) → USD per 1M tokens, as the form shows it. */
export function perMillion(perToken: string | undefined): string {
  if (perToken === undefined || perToken === '') return '';
  const value = Number(perToken);
  if (!Number.isFinite(value)) return '';
  // 12 digits is plenty for per-token prices and absorbs float noise.
  return String(Number((value * MILLION).toPrecision(12)));
}

/** The reverse; null when the text is not a non-negative number. */
export function perToken(perMillionText: string): string | null {
  const text = perMillionText.trim();
  if (text === '') return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return null;
  const result = value / MILLION;
  // Plain decimal, never exponent notation: the API takes decimal strings.
  return result.toFixed(12).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

/**
 * A match pattern as the API compiles it: case-insensitive, with the inline
 * `(?i)` flag the seeded Langfuse patterns start with dropped (JS has none).
 */
export const compilePattern = (pattern: string): RegExp =>
  new RegExp(pattern.replace(/^\(\?i\)/, ''), 'i');

export const defaultTier = (model: ModelPriceInput): PriceTier | undefined =>
  model.tiers.find((tier) => tier.isDefault) ?? model.tiers[0];

export interface PriceForm {
  modelName: string;
  matchPattern: string;
  priority: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite5m: string;
  cacheWrite1h: string;
  reasoning: string;
}

export const EMPTY_PRICE_FORM: PriceForm = {
  modelName: '',
  matchPattern: '',
  priority: '0',
  input: '',
  output: '',
  cacheRead: '',
  cacheWrite5m: '',
  cacheWrite1h: '',
  reasoning: '',
};

const OPTIONAL_BUCKETS = [
  'cacheRead',
  'cacheWrite5m',
  'cacheWrite1h',
  'reasoning',
] as const;

export function formFromModel(model: ModelPriceInput): PriceForm {
  const prices = defaultTier(model)?.prices;
  return {
    modelName: model.modelName,
    matchPattern: model.matchPattern,
    priority: String(model.priority),
    input: perMillion(prices?.input),
    output: perMillion(prices?.output),
    cacheRead: perMillion(prices?.cacheRead),
    cacheWrite5m: perMillion(prices?.cacheWrite5m),
    cacheWrite1h: perMillion(prices?.cacheWrite1h),
    reasoning: perMillion(prices?.reasoning),
  };
}

export type PriceFormResult =
  | { ok: true; model: ModelPriceInput }
  | { ok: false; error: string };

/**
 * A form → a model price. Editing keeps every tier the model already had and
 * rewrites only the default tier's prices; a new model gets one default tier.
 */
export function modelFromForm(
  form: PriceForm,
  existing?: ModelPriceInput,
): PriceFormResult {
  const modelName = form.modelName.trim();
  const matchPattern = form.matchPattern.trim();
  if (!modelName) return { ok: false, error: 'Model name is required.' };
  if (!matchPattern) return { ok: false, error: 'Match pattern is required.' };
  // An untouched stored pattern is the API's to judge; only a new one is checked here.
  if (matchPattern !== existing?.matchPattern) {
    try {
      compilePattern(matchPattern);
    } catch {
      return { ok: false, error: 'The match pattern is not a valid regex.' };
    }
  }
  const priority = Number(form.priority);
  if (!Number.isInteger(priority) || priority < 0) {
    return { ok: false, error: 'Priority is a whole number, 0 or more.' };
  }
  const input = perToken(form.input);
  const output = perToken(form.output);
  if (input === null || output === null) {
    return { ok: false, error: 'Input and output prices are required.' };
  }
  const prices: PriceTier['prices'] = { input, output };
  for (const bucket of OPTIONAL_BUCKETS) {
    const text = form[bucket].trim();
    if (text === '') continue;
    const value = perToken(text);
    if (value === null) {
      return { ok: false, error: `${bucket} must be a non-negative number.` };
    }
    prices[bucket] = value;
  }
  const current = existing ? defaultTier(existing) : undefined;
  const tiers: PriceTier[] = existing
    ? existing.tiers.map((tier) =>
        tier === current ? { ...tier, prices } : tier,
      )
    : [{ name: 'Standard', isDefault: true, conditions: [], prices }];
  return { ok: true, model: { modelName, matchPattern, priority, tiers } };
}

/** A tier's conditions in words: `totalInput > 200000`. */
export function describeConditions(tier: PriceTier): string {
  if (tier.conditions.length === 0) return 'default';
  const ops = { gt: '>', gte: '≥', lt: '<', lte: '≤' } as const;
  return tier.conditions
    .map((c) => `${c.bucket} ${ops[c.op]} ${formatCount(c.value)}`)
    .join(' and ');
}

export function formatPerMillion(perTokenPrice: string | undefined): string {
  const text = perMillion(perTokenPrice);
  return text === '' ? '—' : `$${text}`;
}

export const RECOMPUTE_POLL_MS = 1_500;
