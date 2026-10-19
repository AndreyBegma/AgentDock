import {
  FILTER_ID_NONE,
  FILTER_ID_NONE_COMPOUND,
  FILTER_ID_NONE_MODE,
  FILTER_ID_NONE_OFF,
  FILTER_ID_NONE_UNCOVERED,
  isUnfilteredId,
  runnerPredatesFilterReasons,
  TOKEN_SAVER_UNFILTERED_PROGRAMS_MAX,
  type TokenSavedView,
  type TokenSaverBeforeAfter,
  type TokenSaverCostPerRound,
  type TokenSaverFilterSavings,
  type TokenSaverPromptCache,
  type TokenSaverRunKind,
  type TokenSaverSessionKind,
  type TokenSaverSummary,
  type TokenSaverUnfilteredProgram,
} from '@agentdock/shared';
import type { ChartSeries } from '@andrewbehma/glass-ui/chart';
import { passThroughShare } from './format';

const sum = (a: TokenSavedView, b: TokenSavedView): TokenSavedView => ({
  estimateUsd: a.estimateUsd + b.estimateUsd,
  estimateTokens: a.estimateTokens + b.estimateTokens,
});

/** A summary of nothing — the base `mergeSummaries` folds into. */
export const emptySummary = (from: string, to: string): TokenSaverSummary => ({
  from,
  to,
  pivotAt: null,
  totals: {
    estimateUsd: 0,
    estimateTokens: 0,
    commands: 0,
    rawBytes: 0,
    keptBytes: 0,
  },
  bypassRate: 0,
  passThroughRate: 0,
  beforeAfter: [],
  byDay: [],
  byFilter: [],
  byRunKind: [],
  unfilteredPrograms: [],
  promptCache: [],
  runnerVersion: null,
  costPerRound: [],
});

/** Merges two sides of one run kind: the average is weighted by its runs. */
function mergeBeforeAfter(
  rows: readonly TokenSaverBeforeAfter[],
): TokenSaverBeforeAfter[] {
  const byKind = new Map<
    TokenSaverRunKind,
    {
      beforeRuns: number;
      beforeCost: number;
      afterRuns: number;
      afterCost: number;
    }
  >();
  for (const row of rows) {
    const acc = byKind.get(row.runKind) ?? {
      beforeRuns: 0,
      beforeCost: 0,
      afterRuns: 0,
      afterCost: 0,
    };
    if (row.beforeAvgUsd !== null) {
      acc.beforeRuns += row.beforeRuns;
      acc.beforeCost += Number(row.beforeAvgUsd) * row.beforeRuns;
    }
    if (row.afterAvgUsd !== null) {
      acc.afterRuns += row.afterRuns;
      acc.afterCost += Number(row.afterAvgUsd) * row.afterRuns;
    }
    byKind.set(row.runKind, acc);
  }
  return [...byKind.entries()].map(([runKind, a]) => ({
    runKind,
    beforeRuns: a.beforeRuns,
    beforeAvgUsd: a.beforeRuns > 0 ? String(a.beforeCost / a.beforeRuns) : null,
    afterRuns: a.afterRuns,
    afterAvgUsd: a.afterRuns > 0 ? String(a.afterCost / a.afterRuns) : null,
  }));
}

const byCommands = (
  a: TokenSaverUnfilteredProgram,
  b: TokenSaverUnfilteredProgram,
) => b.commands - a.commands || a.program.localeCompare(b.program);

/** Programs summed across projects, most commands first, the top ten. */
function mergePrograms(
  rows: readonly TokenSaverUnfilteredProgram[],
): TokenSaverUnfilteredProgram[] {
  const byProgram = new Map<string, number>();
  for (const r of rows) {
    byProgram.set(r.program, (byProgram.get(r.program) ?? 0) + r.commands);
  }
  return [...byProgram]
    .map(([program, commands]) => ({ program, commands }))
    .sort(byCommands)
    .slice(0, TOKEN_SAVER_UNFILTERED_PROGRAMS_MAX);
}

/** The prompt cache summed per run kind across projects. */
function mergePromptCache(
  rows: readonly TokenSaverPromptCache[],
): TokenSaverPromptCache[] {
  const byKind = new Map<TokenSaverRunKind, TokenSaverPromptCache>();
  for (const r of rows) {
    const prev = byKind.get(r.runKind);
    byKind.set(r.runKind, {
      runKind: r.runKind,
      runs: (prev?.runs ?? 0) + r.runs,
      input: (prev?.input ?? 0) + r.input,
      cacheRead: (prev?.cacheRead ?? 0) + r.cacheRead,
      cacheWrite: (prev?.cacheWrite ?? 0) + r.cacheWrite,
    });
  }
  return [...byKind.values()];
}

/**
 * Usage on "all projects" asks every project for its summary and shows their
 * sum: totals and per-bucket savings add, the rates are re-derived from the
 * summed commands, before/after averages are weighted by their runs. Programs
 * and the prompt cache add; the runner version is one project's, so the sum
 * has none. Cost per round is medians and percentiles, which do not add, so
 * the sum leaves it empty (#663).
 */
export function mergeSummaries(
  summaries: readonly TokenSaverSummary[],
  from: string,
  to: string,
): TokenSaverSummary {
  const merged = emptySummary(from, to);
  const days = new Map<string, TokenSavedView>();
  const filters = new Map<string, TokenSaverFilterSavings>();
  const kinds = new Map<
    TokenSaverRunKind,
    TokenSavedView & { commands: number }
  >();
  let bypassed = 0;
  let passedThrough = 0;
  for (const s of summaries) {
    const t = s.totals;
    merged.totals = {
      ...sum(merged.totals, t),
      commands: merged.totals.commands + t.commands,
      rawBytes: merged.totals.rawBytes + t.rawBytes,
      keptBytes: merged.totals.keptBytes + t.keptBytes,
    };
    bypassed += s.bypassRate * t.commands;
    passedThrough += s.passThroughRate * t.commands;
    if (s.pivotAt && (!merged.pivotAt || s.pivotAt < merged.pivotAt)) {
      merged.pivotAt = s.pivotAt;
    }
    for (const d of s.byDay) {
      days.set(d.day, sum(days.get(d.day) ?? zero, d));
    }
    for (const f of s.byFilter) {
      const prev = filters.get(f.filter);
      filters.set(f.filter, {
        filter: f.filter,
        ...sum(prev ?? zero, f),
        commands: (prev?.commands ?? 0) + f.commands,
        bypassed: (prev?.bypassed ?? 0) + f.bypassed,
        passedThrough: (prev?.passedThrough ?? 0) + f.passedThrough,
      });
    }
    for (const k of s.byRunKind) {
      const prev = kinds.get(k.runKind);
      kinds.set(k.runKind, {
        ...sum(prev ?? zero, k),
        commands: (prev?.commands ?? 0) + k.commands,
      });
    }
  }
  const commands = merged.totals.commands;
  merged.bypassRate = commands > 0 ? bypassed / commands : 0;
  merged.passThroughRate = commands > 0 ? passedThrough / commands : 0;
  merged.beforeAfter = mergeBeforeAfter(
    summaries.flatMap((s) => s.beforeAfter),
  );
  merged.byDay = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, v]) => ({ day, ...v }));
  merged.byFilter = [...filters.values()].sort(bySaved);
  merged.byRunKind = [...kinds.entries()]
    .map(([runKind, v]) => ({ runKind, ...v }))
    .sort((a, b) => b.estimateUsd - a.estimateUsd);
  merged.unfilteredPrograms = mergePrograms(
    summaries.flatMap((s) => s.unfilteredPrograms),
  );
  merged.promptCache = mergePromptCache(
    summaries.flatMap((s) => s.promptCache),
  );
  return merged;
}

/**
 * #648: the reasons in the order the dashboard lists them, the legacy `none`
 * last; #663 D9 adds a switched-off family.
 */
export const UNFILTERED_REASONS = [
  FILTER_ID_NONE_COMPOUND,
  FILTER_ID_NONE_UNCOVERED,
  FILTER_ID_NONE_MODE,
  FILTER_ID_NONE_OFF,
  FILTER_ID_NONE,
] as const;

/** #663 D5: one session kind's cost per round, its newest week against its oldest. */
export interface CostPerRoundTrend {
  sessionKind: TokenSaverSessionKind;
  latest: TokenSaverCostPerRound;
  /** The oldest week in the range; `null` when the kind has only one. */
  earliest: TokenSaverCostPerRound | null;
  /** Median cost, latest against earliest, as a fraction; `null` when either is unknown or the earliest is 0. */
  change: number | null;
}

/**
 * #663 D5: the lead table — per session kind, the newest week with rounds and
 * how its median cost moved from the oldest week in the range. Kinds keep the
 * summary's order (`TOKEN_SAVER_SESSION_KINDS`).
 */
export function costPerRoundTrends(
  rows: readonly TokenSaverCostPerRound[],
): CostPerRoundTrend[] {
  const byKind = new Map<TokenSaverSessionKind, TokenSaverCostPerRound[]>();
  for (const r of rows) {
    byKind.set(r.sessionKind, [...(byKind.get(r.sessionKind) ?? []), r]);
  }
  return [...byKind].flatMap(([sessionKind, weeks]): CostPerRoundTrend[] => {
    const sorted = [...weeks].sort((a, b) => a.week.localeCompare(b.week));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (!first || !last) return [];
    const earliest = sorted.length > 1 ? first : null;
    const change = earliest
      ? usdChange(earliest.medianUsd, last.medianUsd)
      : null;
    return [{ sessionKind, latest: last, earliest, change }];
  });
}

/**
 * #648: "No filter" split by reason — one row per reason, always all five,
 * with its commands and its share of the unfiltered ones (0–1).
 */
export function unfilteredReasons(
  filters: readonly TokenSaverFilterSavings[],
): { filter: string; commands: number; share: number }[] {
  const count = (id: string) =>
    filters.find((f) => f.filter === id)?.commands ?? 0;
  const total = UNFILTERED_REASONS.reduce((n, id) => n + count(id), 0);
  return UNFILTERED_REASONS.map((filter) => ({
    filter,
    commands: count(filter),
    share: total > 0 ? count(filter) / total : 0,
  }));
}

/**
 * #648: whether to say the runner is too old to give reasons — its version
 * predates them and none of the range's rows carries one (a build from the
 * main branch still says 0.12.2 but sends them).
 */
export function runnerTooOldForReasons(summary: TokenSaverSummary): boolean {
  return (
    runnerPredatesFilterReasons(summary.runnerVersion) &&
    !summary.byFilter.some(
      (f) => isUnfilteredId(f.filter) && f.filter !== FILTER_ID_NONE,
    )
  );
}

/** #648: the prompt cache of every run kind together, for the tile. */
export function promptCacheTotals(
  rows: readonly TokenSaverPromptCache[],
): Omit<TokenSaverPromptCache, 'runKind'> {
  return rows.reduce(
    (t, r) => ({
      runs: t.runs + r.runs,
      input: t.input + r.input,
      cacheRead: t.cacheRead + r.cacheRead,
      cacheWrite: t.cacheWrite + r.cacheWrite,
    }),
    { runs: 0, input: 0, cacheRead: 0, cacheWrite: 0 },
  );
}

const zero: TokenSavedView = { estimateUsd: 0, estimateTokens: 0 };

const bySaved = (a: TokenSaverFilterSavings, b: TokenSaverFilterSavings) =>
  b.estimateUsd - a.estimateUsd ||
  b.estimateTokens - a.estimateTokens ||
  a.filter.localeCompare(b.filter);

/** The Usage and dashboard "top filters": most saved first, a limit. */
export const topFilters = (
  filters: readonly TokenSaverFilterSavings[],
  limit: number,
): TokenSaverFilterSavings[] =>
  filters
    .filter((f) => !isUnfilteredId(f.filter))
    .slice()
    .sort(bySaved)
    .slice(0, limit);

/**
 * The dashboard's "filters that most often returned the original" (D13): by
 * the share of their commands that passed through, then by how many; a filter
 * that never passed through is left out. `none` and the `none:*` reasons (no
 * filter ran) are the extreme case and stay in — exactly what the person
 * should see.
 */
export function mostPassedThrough(
  filters: readonly TokenSaverFilterSavings[],
  limit: number,
): TokenSaverFilterSavings[] {
  return filters
    .filter((f) => f.passedThrough > 0)
    .slice()
    .sort(
      (a, b) =>
        passThroughShare(b) - passThroughShare(a) ||
        b.passedThrough - a.passedThrough ||
        a.filter.localeCompare(b.filter),
    )
    .slice(0, limit);
}

/** One bar per UTC day with commands; `x` is the day's midnight (UTC). */
export function savingsChartSeries(
  byDay: TokenSaverSummary['byDay'],
): ChartSeries[] {
  return [
    {
      id: 'saved',
      name: 'Saved ≈',
      kind: 'bar',
      color: 'series-1',
      points: byDay.map((d) => ({
        x: new Date(`${d.day}T00:00:00Z`).getTime(),
        y: d.estimateUsd,
      })),
    },
  ];
}

/** The change between the two sides of a run kind, as a fraction; null when either is unknown or "before" is 0. */
export function costChange(row: TokenSaverBeforeAfter): number | null {
  return usdChange(row.beforeAvgUsd, row.afterAvgUsd);
}

/** The change from one decimal cost to another, as a fraction; null when either is unknown or `before` is 0. */
function usdChange(before: string | null, after: string | null): number | null {
  if (before === null || after === null) return null;
  const b = Number(before);
  const a = Number(after);
  if (!Number.isFinite(b) || !Number.isFinite(a) || b <= 0) return null;
  return (a - b) / b;
}
