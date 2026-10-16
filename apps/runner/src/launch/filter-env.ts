/**
 * #445 (spec Amendment 5): what a launch with Token saver on tells the
 * `filter` and `filter-hook` subprocesses about its run, through the env the
 * session passes to every Bash command.
 *
 * TODO(#445, i445-engine): import these from `../filter/env` once it merges;
 * the names here are the spec's and the orchestrator's, literally.
 */

/** The JSONL file in the run dir the `filter` subprocess appends stat rows to. */
export const FILTER_STATS_ENV = 'AGENTDOCK_FILTER_STATS';

/** The directory raw outputs go to: `<run dir>/raw` (D4a, Amendment 6). */
export const FILTER_RAW_DIR_ENV = 'AGENTDOCK_FILTER_RAW_DIR';

/** The stat row's `runKind`. */
export const FILTER_RUN_KIND_ENV = 'AGENTDOCK_FILTER_RUN_KIND';

/** The stat row's `runId`; never set for the orchestrator session. */
export const FILTER_RUN_ID_ENV = 'AGENTDOCK_FILTER_RUN_ID';

/**
 * The `--settings` file of the launch: `filter-hook` reads its `Bash(...)`
 * permission rules, next to the usual Claude settings files, and rewrites
 * only when the rewrite changes no permission outcome.
 */
export const LAUNCH_SETTINGS_ENV = 'AGENTDOCK_LAUNCH_SETTINGS';
