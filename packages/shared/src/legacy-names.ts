/**
 * ADR-0073: the names the runner and its protocol had before the rename to
 * Nautelle. Runner 0.14 and 0.15 accept them beside the new ones; 0.16.0
 * removes them, with this file.
 */

export const ENV_PREFIX = 'NAUTELLE_';
export const LEGACY_ENV_PREFIX = 'AGENTDOCK_';

type EnvLike = Readonly<Record<string, string | undefined>>;

/** `NAUTELLE_X` → `AGENTDOCK_X`; null for a name without the new prefix. */
export const legacyEnvName = (name: string): string | null =>
  name.startsWith(ENV_PREFIX)
    ? LEGACY_ENV_PREFIX + name.slice(ENV_PREFIX.length)
    : null;

/** The value of `name`, or of its legacy name when `name` is unset. */
export const readEnv = (env: EnvLike, name: string): string | undefined => {
  const value = env[name];
  if (value !== undefined) return value;
  const legacy = legacyEnvName(name);
  return legacy === null ? undefined : env[legacy];
};

/**
 * `name=value` under the new and the legacy name, for a process the runner
 * starts: programs outside the runner still read the legacy one.
 */
export const bothEnvNames = (
  name: string,
  value: string,
): Record<string, string> => {
  const legacy = legacyEnvName(name);
  return legacy === null
    ? { [name]: value }
    : { [name]: value, [legacy]: value };
};

/** Every tmux session the runner starts begins with this. */
export const SESSION_PREFIX = 'nautelle-';
export const LEGACY_SESSION_PREFIX = 'agentdock-';

/** `nautelle-card-x` → `agentdock-card-x`; null for any other name. */
export const legacySessionName = (name: string): string | null =>
  name.startsWith(SESSION_PREFIX)
    ? LEGACY_SESSION_PREFIX + name.slice(SESSION_PREFIX.length)
    : null;

/** The regex source that matches either session prefix. */
export const SESSION_PREFIX_PATTERN = '(?:nautelle|agentdock)-';

/** The runner's MCP server, in the plugin and in every launch. */
export const RUNNER_MCP_SERVER = 'nautelle';
export const LEGACY_RUNNER_MCP_SERVER = 'agentdock';

/** Whether `name` is the runner's own MCP server, under either name. */
export const isRunnerMcpServer = (name: string): boolean =>
  name === RUNNER_MCP_SERVER || name === LEGACY_RUNNER_MCP_SERVER;
