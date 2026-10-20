import { isAbsolute, join } from 'node:path';
import { DIR_NAME, type Env, LEGACY_DIR_NAME } from '../env';

/**
 * The runtime directory that holds the daemon's socket, `$XDG_RUNTIME_DIR/nautelle`,
 * or null where the socket lives in the state dir instead (macOS, or no
 * runtime dir): macOS runtime dirs are long, and a unix socket path is capped
 * near 104 bytes there. `legacy` gives the name before ADR-0073.
 */
export const localRuntimeDir = (
  env: Env,
  os: string,
  legacy = false,
): string | null => {
  const runtime = env.XDG_RUNTIME_DIR;
  if (os === 'darwin' || !runtime || !isAbsolute(runtime)) return null;
  return join(runtime, legacy ? LEGACY_DIR_NAME : DIR_NAME);
};

/**
 * The daemon's local socket (spec 201 D5): `$XDG_RUNTIME_DIR/nautelle/runner.sock`,
 * else `<stateDir>/runner.sock`. `stateDir` is the directory that holds the
 * spool (`~/.local/state/nautelle`).
 */
export const localSocketPath = (
  env: Env,
  os: string,
  stateDir: string,
): string => join(localRuntimeDir(env, os) ?? stateDir, 'runner.sock');
