import { realpathSync } from 'node:fs';
import type { WatchedProject } from '@nautelle/shared/protocol';
import { CommandFailure } from '../commands/failure';
import { watchedProject } from '../control/target';
import type { Exec } from '../detect/exec';
import { parseRemote } from '../projects/remote';

/** A docs repository's local clone, as a docs command may use it. */
export interface DocsRepo {
  /** The clone's real top-level path. */
  root: string;
  /** `owner/name` on GitHub, from the clone's origin. */
  github: string;
}

const out = async (
  exec: Exec,
  args: readonly string[],
): Promise<string | null> => {
  const result = await exec('git', args);
  return result && result.code === 0 ? result.stdout.trim() || null : null;
};

/**
 * #379: the docs clone a docs command names. The code project must be on
 * the watch list (as every project command), and `docsRoot` must be the top
 * of a git repository — not a folder inside one, not the code repository —
 * whose origin is on GitHub. Nothing is written before this passes.
 */
export const docsRepoOf = async (
  args: { projectId: string; root: string; docsRoot: string },
  deps: { exec: Exec; watchedProjects: () => readonly WatchedProject[] },
): Promise<DocsRepo> => {
  const project = watchedProject(args, deps.watchedProjects());
  let real: string;
  try {
    real = realpathSync(args.docsRoot);
  } catch {
    throw new CommandFailure(
      'path_not_found',
      `${args.docsRoot} does not exist`,
    );
  }
  const top = await out(deps.exec, [
    '-C',
    real,
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
  ]);
  if (top === null || realOr(top) !== real) {
    throw new CommandFailure(
      'not_a_repository',
      `${args.docsRoot} is not the top of a git repository`,
    );
  }
  if (realOr(project.root) === real) {
    throw new CommandFailure(
      'path_not_allowed',
      `${args.docsRoot} is the code repository, not a docs repository`,
    );
  }
  const origin = await out(deps.exec, [
    '-C',
    real,
    'remote',
    'get-url',
    'origin',
  ]);
  const github = origin ? parseRemote(origin).repo : null;
  if (!github) {
    throw new CommandFailure(
      'not_a_repository',
      `${args.docsRoot} has no GitHub remote`,
    );
  }
  return { root: real, github };
};

const realOr = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * The docs repository's default branch: `origin/HEAD` in the clone, else
 * what GitHub says.
 */
export const docsBaseOf = async (
  exec: Exec,
  repo: DocsRepo,
): Promise<string> => {
  const head = await out(exec, [
    '-C',
    repo.root,
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  if (head?.startsWith('origin/')) return head.slice('origin/'.length);
  const view = await exec(
    'gh',
    [
      'repo',
      'view',
      repo.github,
      '--json',
      'defaultBranchRef',
      '--jq',
      '.defaultBranchRef.name',
    ],
    { timeoutMs: 40_000 },
  );
  const name = view && view.code === 0 ? view.stdout.trim() : '';
  if (!name) {
    throw new Error(`cannot resolve the default branch of ${repo.github}`);
  }
  return name;
};
