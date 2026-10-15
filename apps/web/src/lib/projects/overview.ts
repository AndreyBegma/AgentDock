import type { FleetView, UsageSeries } from '@agentdock/shared';

/**
 * The Projects list columns that `GET /projects` does not carry (issue #159):
 * orchestrator state, slots, last activity and the 7-day cost. They come from
 * `GET /projects/:id/fleet` per row and one `GET /usage/timeseries` for all
 * projects. A column whose source failed is `null` — shown as a dash, never as
 * a made-up "idle" or "$0".
 */
export const COST_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC day starts of the last `days` days, oldest first, today included. */
export function lastDays(now: number, days = COST_DAYS): string[] {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  return Array.from({ length: days }, (_, i) =>
    new Date(today - (days - 1 - i) * DAY_MS).toISOString(),
  );
}

/** The query string of the one timeseries call that covers every project. */
export function costQuery(now: number, days = COST_DAYS): string {
  const [first] = lastDays(now, days);
  const to = new Date(Math.floor(now / DAY_MS) * DAY_MS + DAY_MS);
  return `from=${encodeURIComponent(first ?? to.toISOString())}&to=${encodeURIComponent(to.toISOString())}&interval=day&groupBy=project`;
}

export interface CostTrend {
  /** One value per day, oldest first; days with no spend are 0. */
  values: number[];
  total: number;
}

/** A project's daily cost, zero-filled over `days` (the series has gaps). */
export function costTrend(
  series: readonly UsageSeries[],
  projectId: string,
  days: readonly string[],
): CostTrend {
  const mine = series.find((s) => s.key === projectId);
  const byDay = new Map<number, number>();
  for (const point of mine?.points ?? []) {
    const cost = Number(point.costUsd);
    if (Number.isFinite(cost)) byDay.set(Date.parse(point.t), cost);
  }
  const values = days.map((day) => byDay.get(Date.parse(day)) ?? 0);
  return { values, total: values.reduce((sum, v) => sum + v, 0) };
}

/** Whether a sparkline can say anything: it needs two non-zero days. */
export const hasTrend = (trend: CostTrend): boolean =>
  trend.values.filter((v) => v > 0).length >= 2;

/** The latest sign of life the fleet view shows: the last round or the last state change. */
export function lastActivity(fleet: FleetView): string | null {
  const times = [fleet.latestRound?.createdAt, fleet.orchestrator.since]
    .filter((t): t is string => typeof t === 'string')
    .map((t) => Date.parse(t))
    .filter((t) => Number.isFinite(t));
  return times.length > 0 ? new Date(Math.max(...times)).toISOString() : null;
}
