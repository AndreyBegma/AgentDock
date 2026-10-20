import { appendFileSync } from 'node:fs';
import type { FilterStatRow, TokenSaverRunKind } from '@nautelle/shared';
import {
  FILTER_PROJECT_ENV,
  FILTER_RUN_ENV,
  FILTER_RUN_KIND_ENV,
  FILTER_STATS_ENV,
  type FilterLaunch,
} from './env';

/**
 * One line of `<run dir>/filter-stats.jsonl` (amendment 5): the row the
 * daemon sends in `filter.stats`, and the project its envelope names.
 */
export interface StatsLine {
  projectId: string;
  row: FilterStatRow;
}

/** Mirrors `TOKEN_SAVER_RUN_KINDS`; a test pins the two together. */
export const RUN_KINDS: readonly TokenSaverRunKind[] = [
  'card',
  'skill',
  'plan',
  'card_assess',
  'card_capture',
  'ui_profile',
  'text_normalize',
  'orchestrator',
  'manual',
];

export interface StatsTarget extends Omit<FilterLaunch, 'runDir'> {
  /** The stats file; its directory is the run dir. */
  file: string;
}

/**
 * Where this process reports, from the env the launch set — or `null` when
 * the env is missing or inconsistent, and the filter then stays out of the
 * way entirely.
 */
export const statsTarget = (
  env: Readonly<Record<string, string | undefined>>,
): StatsTarget | null => {
  const file = env[FILTER_STATS_ENV];
  const projectId = env[FILTER_PROJECT_ENV];
  const runKind = RUN_KINDS.find((k) => k === env[FILTER_RUN_KIND_ENV]);
  const runId = env[FILTER_RUN_ENV] || null;
  if (!file?.startsWith('/') || !projectId || !runKind) return null;
  // A manual (`/cs-eco`, #475) session names itself or nothing; the daemon
  // sends its rows with `runId: null` either way.
  if (runKind !== 'manual' && (runKind === 'orchestrator') !== (runId === null))
    return null;
  return { file, projectId, runId, runKind };
};

/** A row id: unique per command, safe to resend (the API dedupes on it). */
export const statRowId = (now: number, random: () => number): string =>
  `f_${now.toString(36)}${Math.floor(random() * 36 ** 8)
    .toString(36)
    .padStart(8, '0')}`;

export interface StatsCounts {
  filter: string;
  /** #648: the program the command ran (`git log`); absent for a read. */
  program?: string;
  rawBytes: number;
  keptBytes: number;
  bypassed: boolean;
  passedThrough: boolean;
}

/**
 * Appends one row. A line is far below `PIPE_BUF`, so concurrent appends of
 * one session never interleave. Never throws: stats are not worth failing a
 * command over.
 */
export const writeStat = (
  target: StatsTarget,
  counts: StatsCounts,
  now: number,
  random: () => number = Math.random,
): void => {
  const line: StatsLine = {
    projectId: target.projectId,
    row: {
      id: statRowId(now, random),
      runId: target.runId,
      runKind: target.runKind,
      ...counts,
      at: new Date(now).toISOString(),
    },
  };
  try {
    appendFileSync(target.file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch {
    // The run dir may be gone already; the command's result matters more.
  }
};
