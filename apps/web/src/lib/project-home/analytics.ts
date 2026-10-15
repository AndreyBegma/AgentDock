import type {
  RunKind,
  RunStatus,
  RunSummary,
  UsageTimeseriesResponse,
} from '@agentdock/shared';
import type { StatTileDelta } from '@andrewbehma/glass-ui/stat-tile';
import { presetRange, type UsageRange } from '../usage/format';

/**
 * The project page's figures (card C-6): pure, so the rules are tested
 * without a page. Every figure is computed from what the API already serves —
 * the project's runs, its usage and its queue.
 */

export const PROJECT_PERIODS = ['24h', '7d', '30d'] as const;
export type ProjectPeriod = (typeof PROJECT_PERIODS)[number];
export const DEFAULT_PERIOD: ProjectPeriod = '7d';

export const PERIOD_LABEL: Record<ProjectPeriod, string> = {
  '24h': 'last 24 hours',
  '7d': 'last 7 days',
  '30d': 'last 30 days',
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** `?period=` as the page reads it; anything else is the default. */
export function parsePeriod(raw: string | null | undefined): ProjectPeriod {
  return PROJECT_PERIODS.find((p) => p === raw) ?? DEFAULT_PERIOD;
}

export interface PeriodRanges {
  current: UsageRange;
  /** The same length, just before `current` — what a delta compares with. */
  previous: UsageRange;
  /** A day for 24 h is one bar; hours read better there. */
  bucketMs: number;
}

export function periodRanges(
  period: ProjectPeriod,
  now: Date = new Date(),
): PeriodRanges {
  const current = presetRange(period, now);
  const span = Date.parse(current.to) - Date.parse(current.from);
  return {
    current,
    previous: {
      from: new Date(Date.parse(current.from) - span).toISOString(),
      to: current.from,
    },
    bucketMs: period === '24h' ? HOUR_MS : DAY_MS,
  };
}

/** The start of every bucket in `range`, oldest first. */
export function bucketStarts(range: UsageRange, bucketMs: number): number[] {
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  const starts: number[] = [];
  for (let t = from; t < to; t += bucketMs) starts.push(t);
  return starts;
}

const bucketIndex = (
  iso: string,
  range: UsageRange,
  bucketMs: number,
): number => {
  const t = Date.parse(iso);
  if (t < Date.parse(range.from) || t >= Date.parse(range.to)) return -1;
  return Math.floor((t - Date.parse(range.from)) / bucketMs);
};

/** A run that ended with its pull request merged. */
export const isMerged = (run: Pick<RunSummary, 'status' | 'prNumber'>) =>
  run.status === 'succeeded' && run.prNumber !== null;

export interface Throughput {
  starts: number[];
  merged: number[];
  failed: number[];
}

/** Runs that finished in each bucket: merged pull requests and failures. */
export function throughput(
  runs: readonly RunSummary[],
  range: UsageRange,
  bucketMs: number,
): Throughput {
  const starts = bucketStarts(range, bucketMs);
  const merged = starts.map(() => 0);
  const failed = starts.map(() => 0);
  for (const run of runs) {
    if (run.endedAt === null) continue;
    const i = bucketIndex(run.endedAt, range, bucketMs);
    if (i < 0) continue;
    if (isMerged(run)) merged[i] = (merged[i] ?? 0) + 1;
    else if (run.status === 'failed') failed[i] = (failed[i] ?? 0) + 1;
  }
  return { starts, merged, failed };
}

/** The middle value; null for none. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? null)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** How long a merged run took, start to merge — the project's lead time. */
export function leadTimes(runs: readonly RunSummary[]): number[] {
  return runs.flatMap((run) =>
    isMerged(run) && run.durationMs !== null ? [run.durationMs] : [],
  );
}

/** The median lead time of the runs that merged in each bucket; 0 for none. */
export function leadTimeTrend(
  runs: readonly RunSummary[],
  range: UsageRange,
  bucketMs: number,
): number[] {
  const starts = bucketStarts(range, bucketMs);
  const per: number[][] = starts.map(() => []);
  for (const run of runs) {
    if (!isMerged(run) || run.endedAt === null || run.durationMs === null) {
      continue;
    }
    const i = bucketIndex(run.endedAt, range, bucketMs);
    if (i >= 0) per[i]?.push(run.durationMs);
  }
  return per.map((values) => median(values) ?? 0);
}

/**
 * Merged out of finished: a run still at work, waiting on a person, or
 * abandoned without a PR is not a verdict yet. Null when nothing finished.
 */
export function successRate(
  counts: Pick<Record<RunStatus, number>, 'succeeded' | 'failed'>,
): number | null {
  const finished = counts.succeeded + counts.failed;
  return finished === 0 ? null : counts.succeeded / finished;
}

/** Each bucket's cost, every series summed. */
export function costTrend(response: Pick<UsageTimeseriesResponse, 'series'>) {
  const byTime = new Map<string, number>();
  for (const series of response.series) {
    for (const point of series.points) {
      const cost = Number(point.costUsd);
      byTime.set(
        point.t,
        (byTime.get(point.t) ?? 0) + (Number.isFinite(cost) ? cost : 0),
      );
    }
  }
  return [...byTime.entries()]
    .sort(([a], [b]) => Date.parse(a) - Date.parse(b))
    .map(([, cost]) => cost);
}

/**
 * How `current` moved against `previous`, as a tile's delta. `higherIsGood`
 * picks the sentiment: merges up is good, cost up is bad. Undefined when
 * there is nothing to compare with.
 */
export function percentDelta(
  current: number,
  previous: number | null | undefined,
  higherIsGood: boolean,
): StatTileDelta | undefined {
  if (previous === null || previous === undefined || previous === 0) {
    return undefined;
  }
  const change = (current - previous) / previous;
  const rounded = Math.round(Math.abs(change) * 100);
  if (rounded === 0) {
    return { value: 'no change', direction: 'flat', sentiment: 'neutral' };
  }
  const up = change > 0;
  return {
    value: `${rounded}%`,
    direction: up ? 'up' : 'down',
    sentiment: up === higherIsGood ? 'good' : 'bad',
  };
}

/** The runs that are bookkeeping, not work: never a "task" on this page. */
const HOUSEKEEPING: ReadonlySet<RunKind> = new Set([
  'card_capture',
  'text_normalize',
]);

export const isTask = (run: Pick<RunSummary, 'kind'>): boolean =>
  !HOUSEKEEPING.has(run.kind);

export interface KindShare {
  kind: RunKind;
  ms: number;
  /** 0–1 of every task's time. */
  share: number;
}

/**
 * Where the agents' time went, by kind of run, largest first. A run without a
 * recorded duration counts from its start to its end, or to `now` while at work.
 */
export function timeByKind(
  runs: readonly RunSummary[],
  now: number = Date.now(),
): KindShare[] {
  const ms = new Map<RunKind, number>();
  for (const run of runs) {
    if (!isTask(run)) continue;
    const end = run.endedAt === null ? now : Date.parse(run.endedAt);
    const spent =
      run.durationMs ?? Math.max(0, end - Date.parse(run.startedAt));
    if (spent > 0) ms.set(run.kind, (ms.get(run.kind) ?? 0) + spent);
  }
  const total = [...ms.values()].reduce((sum, v) => sum + v, 0);
  return [...ms.entries()]
    .map(([kind, value]) => ({ kind, ms: value, share: value / total }))
    .sort((a, b) => b.ms - a.ms);
}

/** "3h 42m", "18m", "45s" — a tile's compact duration. */
export function shortDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  return `${Math.round(hours / 24)}d`;
}
