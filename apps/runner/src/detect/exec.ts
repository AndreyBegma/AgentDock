import type { Env } from '../env';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a binary found on `PATH` with fixed arguments — never a shell string.
 * Resolves `null` when the binary is absent, cannot start or times out.
 */
export type Exec = (
  binary: string,
  args: readonly string[],
  options?: ExecOptions,
) => Promise<ExecResult | null>;

export interface ExecOptions {
  /** Overrides the factory's timeout for this call (a network call to `gh`). */
  timeoutMs?: number;
  /**
   * #329 D1: git settings for this child, as `GIT_CONFIG_COUNT` /
   * `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` — appended after any the
   * runner's own environment already carries, never replacing them.
   */
  gitConfig?: readonly (readonly [key: string, value: string])[];
}

/** Capability probes give up after this long (D5). */
export const EXEC_TIMEOUT_MS = 5_000;

const definedOnly = (env: Env): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  );

/**
 * `env` with `entries` added as `GIT_CONFIG_*` variables. An inherited
 * `GIT_CONFIG_COUNT` keeps its entries: the new ones follow them, so they
 * also win over them (later entries override earlier ones).
 */
export const withGitConfig = (
  env: Record<string, string>,
  entries: readonly (readonly [string, string])[],
): Record<string, string> => {
  if (entries.length === 0) return env;
  const inherited = Number(env.GIT_CONFIG_COUNT ?? 0);
  const start = Number.isInteger(inherited) && inherited > 0 ? inherited : 0;
  const added: Record<string, string> = {
    GIT_CONFIG_COUNT: String(start + entries.length),
  };
  entries.forEach(([key, value], i) => {
    added[`GIT_CONFIG_KEY_${start + i}`] = key;
    added[`GIT_CONFIG_VALUE_${start + i}`] = value;
  });
  return { ...env, ...added };
};

export const createExec =
  (env: Env, timeoutMs = EXEC_TIMEOUT_MS): Exec =>
  async (binary, args, options) => {
    const path = Bun.which(binary, { PATH: env.PATH ?? '' });
    if (!path) return null;
    try {
      const proc = Bun.spawn([path, ...args], {
        env: withGitConfig(definedOnly(env), options?.gitConfig ?? []),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: options?.timeoutMs ?? timeoutMs,
        killSignal: 'SIGKILL',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (proc.signalCode !== null) return null;
      return { code, stdout, stderr };
    } catch {
      return null;
    }
  };
