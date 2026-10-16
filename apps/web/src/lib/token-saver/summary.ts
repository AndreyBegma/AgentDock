import type {
  TokenSavedView,
  TokenSaverBeforeAfter,
  TokenSaverFilterSavings,
  TokenSaverRunKind,
  TokenSaverSummary,
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

/**
 * Usage on "all projects" asks every project for its summary and shows their
 * sum: totals and per-bucket savings add, the rates are re-derived from the
 * summed commands, before/after averages are weighted by their runs.
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
  return merged;
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
    .filter((f) => f.filter !== 'none')
    .slice()
    .sort(bySaved)
    .slice(0, limit);

/**
 * The dashboard's "filters that most often returned the original" (D13): by
 * the share of their commands that passed through, then by how many; a filter
 * that never passed through is left out. `none` (an uncovered command) is
 * the extreme case and stays in — it is exactly what the person should see.
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
  if (row.beforeAvgUsd === null || row.afterAvgUsd === null) return null;
  const before = Number(row.beforeAvgUsd);
  const after = Number(row.afterAvgUsd);
  if (!Number.isFinite(before) || !Number.isFinite(after) || before <= 0) {
    return null;
  }
  return (after - before) / before;
}
