import { realpathSync } from 'node:fs';
import { basename, dirname, sep } from 'node:path';
import type { Exec } from '../detect/exec';

/** Resolves symlinks; null when the path does not exist. */
export type Realpath = (path: string) => string | null;

export const nodeRealpath: Realpath = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

const isWithin = (path: string, dir: string): boolean =>
  dir === sep ||
  path === dir ||
  path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);

/**
 * ADR-0046: why `root` is outside `allowedRoots`, or null when it is inside.
 * Both sides are compared as real paths, so a symlink into an allowed root
 * that points elsewhere is refused, and a path that does not exist is too.
 */
export const rootOutsideAllowed = (
  root: string,
  allowedRoots: readonly string[],
  realpath: Realpath,
): string | null => {
  if (!root.startsWith('/')) return `${root} is not an absolute path`;
  if (allowedRoots.length === 0) {
    return 'this runner allows no project root yet';
  }
  const real = realpath(root);
  if (real === null) return `${root} does not exist`;
  const inside = allowedRoots.some((allowed) => {
    const dir = realpath(allowed);
    return dir !== null && isWithin(real, dir);
  });
  if (inside) return null;
  return real === root
    ? `${root} is outside the allowed roots`
    : `${root} resolves to ${real}, outside the allowed roots`;
};

/**
 * Why `root` is not a git main checkout, or null when it is: git's top level
 * must be the root itself and hold the common `.git` (not a linked worktree,
 * not a subdirectory).
 */
export const notMainCheckout = async (
  exec: Exec,
  root: string,
  realpath: Realpath,
): Promise<string | null> => {
  const real = realpath(root);
  if (real === null) return `${root} does not exist`;
  const result = await exec('git', [
    '-C',
    real,
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
    '--show-toplevel',
  ]);
  const [commonDir, toplevel] =
    result?.code === 0 ? result.stdout.trim().split('\n') : [];
  if (!commonDir || !toplevel) return `${root} is not a git repository`;
  const mainRoot =
    basename(commonDir) === '.git' ? dirname(commonDir) : toplevel;
  if (real !== toplevel || toplevel !== mainRoot) {
    return `${root} is not a git main checkout`;
  }
  return null;
};
