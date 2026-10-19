import { join } from 'node:path';
import type { TokenSaverRunKind } from '@agentdock/shared';

/**
 * The environment a launch gives its Claude session so the command-output
 * filter (#445, ADR-0039) knows where to write and whom to count for. The
 * one source of these names: `launch/token-saver.ts` spreads `filterEnv(…)`
 * into every launch's env; the `filter` and `filter-hook` subcommands read
 * these names and nothing else.
 *
 * Kept free of runtime imports: this module is on the filter's hot path,
 * which must start in milliseconds (D3).
 */

/** `<run dir>/filter-stats.jsonl`: one row per filtered command (amendment 5). */
export const FILTER_STATS_ENV = 'AGENTDOCK_FILTER_STATS';
/** The project the launch runs for — the `filter.stats` envelope's project. */
export const FILTER_PROJECT_ENV = 'AGENTDOCK_FILTER_PROJECT';
/** The launch's run id; unset for the orchestrator session, which has none. */
export const FILTER_RUN_ENV = 'AGENTDOCK_FILTER_RUN';
/** The launch's `TokenSaverRunKind`. */
export const FILTER_RUN_KIND_ENV = 'AGENTDOCK_FILTER_RUN_KIND';

/**
 * The `--settings` file the launch passed to Claude. The hook reads its
 * permission rules next to the ones Claude loads from the usual places, so a
 * rewrite never changes what the session allows, asks or denies.
 */
export const LAUNCH_SETTINGS_ENV = 'AGENTDOCK_LAUNCH_SETTINGS';

/**
 * The bypass (D4c): `AGENTDOCK_RAW=1 <cmd>`. Mirrors `TOKEN_SAVER_RAW_ENV`
 * from `@agentdock/shared`, which this hot path does not load; a test pins
 * the two together.
 */
export const RAW_ENV = 'AGENTDOCK_RAW';

/**
 * #663 D9: the filter families switched off for this launch, comma-separated
 * (`js,ops`; `tool` is the Bash read refusal). The launch sets it from the
 * project's setting. A command of a switched-off family passes through.
 */
export const FILTER_OFF_ENV = 'AGENTDOCK_FILTER_OFF';

/** The families named in `AGENTDOCK_FILTER_OFF`. */
export const switchedOffFamilies = (
  env: Readonly<Record<string, string | undefined>>,
): ReadonlySet<string> =>
  new Set(
    (env[FILTER_OFF_ENV] ?? '')
      .split(',')
      .map((family) => family.trim())
      .filter(Boolean),
  );

/** `family/command` → `family`. */
export const familyOf = (filterId: string): string =>
  filterId.split('/')[0] ?? filterId;

/** The stats file's name inside a run dir. */
export const FILTER_STATS_FILE = 'filter-stats.jsonl';
/**
 * Who the run dir belongs to, `FilterLaunch` minus the dir, written by the
 * launch. The stats reader takes a row's project and run from this file,
 * never from the row (DR-05).
 */
export const FILTER_RUN_FILE = 'filter-run.json';
/** The raw outputs' directory inside a run dir (amendment 6). */
export const FILTER_RAW_DIR = 'raw';
/**
 * Where the orchestrator sessions keep their filter files: it has no run dir,
 * so it gets one per repository under the runner's state dir.
 */
export const FILTER_ORCHESTRATOR_DIR = 'orchestrator';

export interface FilterLaunch {
  /** The launch's own directory; stats and raw outputs go inside it. */
  runDir: string;
  projectId: string;
  /** `null` exactly for the orchestrator session. */
  runId: string | null;
  runKind: TokenSaverRunKind;
}

/** The env a launch with Token saver on adds to its session. */
export const filterEnv = (launch: FilterLaunch): Record<string, string> => ({
  [FILTER_STATS_ENV]: join(launch.runDir, FILTER_STATS_FILE),
  [FILTER_PROJECT_ENV]: launch.projectId,
  ...(launch.runId === null ? {} : { [FILTER_RUN_ENV]: launch.runId }),
  [FILTER_RUN_KIND_ENV]: launch.runKind,
});

/**
 * The orchestrator session's run dir for one repository:
 * `<state>/agentdock/orchestrator/<owner>__<name>/`. `stateDir` is the
 * runner's `<state>/agentdock` (the spool's parent).
 */
export const orchestratorFilterDir = (stateDir: string, repo: string): string =>
  join(
    stateDir,
    FILTER_ORCHESTRATOR_DIR,
    repo.replace(/[^A-Za-z0-9_.-]+/g, '__').replace(/^\.+/, '_'),
  );
