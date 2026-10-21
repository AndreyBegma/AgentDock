import { join } from 'node:path';
import type { TokenSaverRunKind } from '@nautelle/shared';

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
export const FILTER_STATS_ENV = 'NAUTELLE_FILTER_STATS';
/** The project the launch runs for — the `filter.stats` envelope's project. */
export const FILTER_PROJECT_ENV = 'NAUTELLE_FILTER_PROJECT';
/** The launch's run id; unset for the orchestrator session, which has none. */
export const FILTER_RUN_ENV = 'NAUTELLE_FILTER_RUN';
/** The launch's `TokenSaverRunKind`. */
export const FILTER_RUN_KIND_ENV = 'NAUTELLE_FILTER_RUN_KIND';

/**
 * The `--settings` file the launch passed to Claude. The hook reads its
 * permission rules next to the ones Claude loads from the usual places, so a
 * rewrite never changes what the session allows, asks or denies.
 */
export const LAUNCH_SETTINGS_ENV = 'NAUTELLE_LAUNCH_SETTINGS';

/**
 * The bypass (D4c): `NAUTELLE_RAW=1 <cmd>`. Mirrors `TOKEN_SAVER_RAW_ENV`
 * from `@nautelle/shared`, which this hot path does not load; a test pins
 * the two together.
 */
export const RAW_ENV = 'NAUTELLE_RAW';

/**
 * #663 D9: the filter families switched off for this launch, comma-separated
 * (`js,ops`; `tool` is the Bash read refusal). The launch sets it from the
 * project's setting. A command of a switched-off family passes through.
 */
export const FILTER_OFF_ENV = 'NAUTELLE_FILTER_OFF';

/** The families named in `NAUTELLE_FILTER_OFF`. */
export const switchedOffFamilies = (
  env: Readonly<Record<string, string | undefined>>,
): ReadonlySet<string> =>
  new Set(
    (env[FILTER_OFF_ENV] ?? '')
      .split(',')
      .map((family) => family.trim())
      .filter(Boolean),
  );

/**
 * #747 D4: the techniques on for this launch, comma-separated
 * (`mcp-cut,read-guard-400`). The launch sets it from `tokenSaver.techniques`;
 * `read-hook` and `tool-hook` read it. Unset is no technique on — the
 * behaviour before #747 (D3).
 */
export const TECHNIQUES_ENV = 'NAUTELLE_TECHNIQUES';

/**
 * #747 D2: the technique keys the hooks act on. Mirrors
 * `TOKEN_ECONOMY_TECHNIQUES` from `@nautelle/shared`, which this hot path does
 * not load; a test pins the two together.
 */
export const TECHNIQUE_MCP_CUT = 'mcp-cut';
export const TECHNIQUE_GREP_CUT = 'grep-cut';
export const TECHNIQUE_WEBFETCH_CUT = 'webfetch-cut';
export const TECHNIQUE_READ_GUARD_400 = 'read-guard-400';
export const TECHNIQUE_TERSE_REGISTER = 'terse-register';
/** #749: the one-hour prompt-cache TTL of a card round; off pins `5m`. */
export const TECHNIQUE_CACHE_TTL_1H = 'cache-ttl-1h';

/** The techniques named in `NAUTELLE_TECHNIQUES`. */
export const techniquesFrom = (
  env: Readonly<Record<string, string | undefined>>,
): ReadonlySet<string> =>
  new Set(
    (env[TECHNIQUES_ENV] ?? '')
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean),
  );

/** Whether `NAUTELLE_TECHNIQUES` names `key`. */
export const techniqueOn = (
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): boolean => techniquesFrom(env).has(key);

/**
 * The env a launch adds for its technique flags: nothing when none is on, so
 * a launch without flags is byte-identical to one before #747.
 */
export const techniquesEnv = (
  flags: Readonly<Record<string, boolean | undefined>> | undefined,
): Record<string, string> => {
  const on = Object.entries(flags ?? {})
    .filter(([, value]) => value === true)
    .map(([key]) => key);
  return on.length === 0 ? {} : { [TECHNIQUES_ENV]: on.join(',') };
};

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
 * `<state>/nautelle/orchestrator/<owner>__<name>/`. `stateDir` is the
 * runner's `<state>/nautelle` (the spool's parent).
 */
export const orchestratorFilterDir = (stateDir: string, repo: string): string =>
  join(
    stateDir,
    FILTER_ORCHESTRATOR_DIR,
    repo.replace(/[^A-Za-z0-9_.-]+/g, '__').replace(/^\.+/, '_'),
  );
