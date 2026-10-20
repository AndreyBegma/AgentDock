import {
  lstatSync,
  mkdirSync,
  renameSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  ENV_PREFIX,
  LEGACY_ENV_PREFIX,
  legacyEnvName,
} from '@nautelle/shared/legacy-names';
import { type Env, resolvePaths } from './env';
import { localRuntimeDir } from './local/paths';

/**
 * ADR-0073: the runner was `agentdock-runner` before 0.14. This module moves
 * what an older runner left on the machine to the new names, on the first
 * start of any command. Runner 0.16.0 removes it.
 *
 * Kept free of the daemon's imports: the filter runs it on every Bash call.
 */

/** One directory the runner moves from its old name to its new one. */
export interface DirMove {
  from: string;
  to: string;
}

export type DirMoveResult =
  /** The old directory was moved and a symlink left at its path. */
  | 'moved'
  /** Nothing to do: no old directory, or it is already the symlink. */
  | 'none'
  /** Both directories exist: nothing moved, the new one is used. */
  | 'both'
  /** The move failed; the new one is used. */
  | 'failed';

export interface LegacyReport {
  /** The `AGENTDOCK_*` variables read because their `NAUTELLE_*` name was unset. */
  env: readonly string[];
  moved: readonly DirMove[];
  both: readonly DirMove[];
  failed: readonly (DirMove & { error: string })[];
}

const code = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | null)?.code;

const exists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Moves `from` to `to` and leaves a symlink at `from`, so paths stored before
 * the move (a card's settings file, a hook's socket) keep resolving. Safe to
 * race: two processes starting at once both end with the move done.
 */
export const migrateDir = ({ from, to }: DirMove): DirMoveResult => {
  try {
    const old = lstatSync(from);
    if (!old.isDirectory()) return 'none';
  } catch {
    return 'none';
  }
  if (exists(to)) return 'both';
  try {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  } catch (error) {
    // Another process moved it first: the outcome is the same.
    if (code(error) === 'ENOENT' && exists(to)) {
      return linkBack(from, to) ? 'moved' : 'failed';
    }
    if (code(error) === 'EEXIST' || code(error) === 'ENOTEMPTY') return 'both';
    throw error;
  }
  return linkBack(from, to) ? 'moved' : 'failed';
};

const linkBack = (from: string, to: string): boolean => {
  try {
    symlinkSync(to, from, 'dir');
    return true;
  } catch (error) {
    if (code(error) !== 'EEXIST') return false;
    // The other process's link, or a directory it recreated: either way
    // `from` exists and the data is at `to`.
    try {
      return statSync(from).isDirectory();
    } catch {
      return false;
    }
  }
};

/** The config, state and runtime directories, old name → new name. */
export const legacyDirMoves = (env: Env, os: string): DirMove[] => {
  const paths = resolvePaths(env);
  const moves = [
    { from: paths.legacy.configDir, to: paths.configDir },
    { from: paths.legacy.stateDir, to: paths.stateDir },
  ];
  const runtime = localRuntimeDir(env, os);
  const legacyRuntime = localRuntimeDir(env, os, true);
  if (runtime && legacyRuntime) {
    moves.push({ from: legacyRuntime, to: runtime });
  }
  return moves;
};

/**
 * The `NAUTELLE_*` values to add to `env`: one for each `AGENTDOCK_*` variable
 * whose new name is unset. The new name always wins.
 */
export const legacyEnvAdoptions = (env: Env): Record<string, string> => {
  const adopted: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !name.startsWith(LEGACY_ENV_PREFIX)) continue;
    const next = ENV_PREFIX + name.slice(LEGACY_ENV_PREFIX.length);
    if (env[next] === undefined) adopted[next] = value;
  }
  return adopted;
};

/**
 * Adds the adoptions to `env` (the process environment, so every child
 * inherits both names) and returns the old names that were read.
 */
export const adoptLegacyEnv = (
  env: Record<string, string | undefined>,
): string[] => {
  const adopted = legacyEnvAdoptions(env);
  Object.assign(env, adopted);
  return Object.keys(adopted)
    .map((name) => legacyEnvName(name) ?? name)
    .sort();
};

/**
 * Moves the old directories. Never throws: a failed move is reported, and the
 * runner goes on with the new names.
 */
export const migrateLegacyDirs = (
  env: Env,
  os: string,
): Omit<LegacyReport, 'env'> => {
  const report = {
    moved: [] as DirMove[],
    both: [] as DirMove[],
    failed: [] as (DirMove & { error: string })[],
  };
  for (const move of legacyDirMoves(env, os)) {
    try {
      const result = migrateDir(move);
      if (result === 'moved') report.moved.push(move);
      if (result === 'both') report.both.push(move);
      if (result === 'failed') {
        report.failed.push({ ...move, error: 'could not link the old path' });
      }
    } catch (error) {
      report.failed.push({ ...move, error: (error as Error).message });
    }
  }
  return report;
};

/** The lines a daemon or a person's command logs about `report`, once per start. */
export const legacyReportLines = (report: LegacyReport): string[] => [
  ...report.env.map(
    (name) =>
      `${name} is deprecated: set ${ENV_PREFIX}${name.slice(LEGACY_ENV_PREFIX.length)} instead; runner 0.16.0 stops reading the old name (ADR-0073)`,
  ),
  ...report.moved.map(
    ({ from, to }) => `moved ${from} to ${to} and left a symlink (ADR-0073)`,
  ),
  ...report.both.map(
    ({ from, to }) =>
      `both ${from} and ${to} exist: using ${to}; remove ${from} once nothing in it is needed (ADR-0073)`,
  ),
  ...report.failed.map(
    ({ from, to, error }) =>
      `could not move ${from} to ${to} (${error}): using ${to} (ADR-0073)`,
  ),
];
