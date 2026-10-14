import { isAbsolute, join } from 'node:path';
import type { Env } from '../env';

/**
 * The daemon's local socket (spec 201 D5): `$XDG_RUNTIME_DIR/agentdock/runner.sock`,
 * else `<stateDir>/runner.sock`. macOS always uses the state dir: its runtime
 * dirs are long, and a unix socket path is capped near 104 bytes there.
 * `stateDir` is the directory that holds the spool (`~/.local/state/agentdock`).
 */
export const localSocketPath = (
  env: Env,
  os: string,
  stateDir: string,
): string => {
  const runtime = env.XDG_RUNTIME_DIR;
  if (os !== 'darwin' && runtime && isAbsolute(runtime)) {
    return join(runtime, 'agentdock', 'runner.sock');
  }
  return join(stateDir, 'runner.sock');
};
