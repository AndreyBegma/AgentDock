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
) => Promise<ExecResult | null>;

/** Capability probes give up after this long (D5). */
export const EXEC_TIMEOUT_MS = 5_000;

const definedOnly = (env: Env): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  );

export const createExec =
  (env: Env, timeoutMs = EXEC_TIMEOUT_MS): Exec =>
  async (binary, args) => {
    const path = Bun.which(binary, { PATH: env.PATH ?? '' });
    if (!path) return null;
    try {
      const proc = Bun.spawn([path, ...args], {
        env: definedOnly(env),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: timeoutMs,
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
