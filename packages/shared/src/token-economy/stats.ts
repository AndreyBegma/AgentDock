/** A point estimate with its 95 % interval; all `null` with no data. */
export interface TokenEconomyInterval {
  point: number | null;
  low: number | null;
  high: number | null;
}

export const NO_INTERVAL: TokenEconomyInterval = {
  point: null,
  low: null,
  high: null,
};

const Z_95 = 1.959964;

/**
 * The Wilson score 95 % interval of a rate (#746 report: signals a, c, d);
 * `NO_INTERVAL` over no trials.
 */
export const wilson = (
  successes: number,
  trials: number,
): TokenEconomyInterval => {
  if (trials <= 0) return NO_INTERVAL;
  const p = successes / trials;
  const z2 = Z_95 * Z_95;
  const denom = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denom;
  const half =
    (Z_95 * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) /
    denom;
  return {
    point: p,
    low: Math.max(0, centre - half),
    high: Math.min(1, centre + half),
  };
};

/** Mulberry32: a small seeded PRNG, so a report is reproducible. */
const prng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

export const BOOTSTRAP_RESAMPLES = 1_000;
const BOOTSTRAP_SEED = 746;

const quantile = (sorted: readonly number[], q: number): number => {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

/**
 * The percentile bootstrap 95 % interval of a statistic over items (#746
 * report: $/successful card and mean rounds), resampled with a fixed seed. A
 * resample whose statistic is `null` (e.g. no merged card) is dropped;
 * `NO_INTERVAL` when the statistic of the items themselves is `null`.
 */
export const bootstrapCi = <T>(
  items: readonly T[],
  statistic: (sample: readonly T[]) => number | null,
  resamples = BOOTSTRAP_RESAMPLES,
): TokenEconomyInterval => {
  const point = items.length === 0 ? null : statistic(items);
  if (point === null) return NO_INTERVAL;
  const random = prng(BOOTSTRAP_SEED);
  const stats: number[] = [];
  const sample: T[] = new Array(items.length);
  for (let r = 0; r < resamples; r += 1) {
    for (let i = 0; i < items.length; i += 1) {
      sample[i] = items[Math.floor(random() * items.length)];
    }
    const value = statistic(sample);
    if (value !== null && Number.isFinite(value)) stats.push(value);
  }
  if (stats.length === 0) return { point, low: null, high: null };
  stats.sort((x, y) => x - y);
  return {
    point,
    low: quantile(stats, 0.025),
    high: quantile(stats, 0.975),
  };
};

/** The median of some numbers; `null` for none. */
export const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  return quantile(
    [...values].sort((x, y) => x - y),
    0.5,
  );
};

/**
 * Whether B is worse than A beyond doubt (#746 `worsens`): B's interval lies
 * wholly on the worse side of A's point estimate.
 */
export const whollyWorse = (
  a: TokenEconomyInterval,
  b: TokenEconomyInterval,
  higherIsBetter: boolean,
): boolean => {
  if (a.point === null || b.low === null || b.high === null) return false;
  return higherIsBetter ? b.high < a.point : b.low > a.point;
};
