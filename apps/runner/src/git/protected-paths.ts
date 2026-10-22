import {
  isProtectedPath,
  PROTECTED_PATHS_MAX,
} from '@nautelle/shared/protocol';
import type { Exec } from '../detect/exec';
import { gitOk } from '../skills/deps';

/**
 * C-148 (D-12, ADR-0077): the pre-push guard's diff. The paths the branch's
 * HEAD changes against its merge base with `origin/<base>` — a rename counts
 * under both names — that are protected (`isProtectedPath`), sorted, at most
 * `PROTECTED_PATHS_MAX`. The push goes ahead either way; the API reads the
 * list and never auto-merges the PR while it is not empty.
 */
export const protectedPathsOf = async (
  exec: Exec,
  worktree: string,
  base: string,
): Promise<string[]> =>
  (
    await gitOk(exec, [
      '-C',
      worktree,
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      `refs/remotes/origin/${base}...HEAD`,
    ])
  )
    .split('\0')
    .filter((path) => path !== '' && isProtectedPath(path))
    .sort()
    .slice(0, PROTECTED_PATHS_MAX);
