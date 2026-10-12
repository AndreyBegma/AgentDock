import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandFailure } from '../commands/failure';
import type { Exec, ExecResult } from '../detect/exec';

/** Under `skill.inspect`'s 120 s and `skill.install`'s 180 s. */
export const CLONE_TIMEOUT_MS = 100_000;

/**
 * D2: the only remote a skill is fetched from. Built here from a `source`
 * that already passed `skillSourceSchema` (`owner/repo`), never from an
 * argument that could carry a host.
 */
export const githubRemote = (source: string): string =>
  `https://github.com/${source}.git`;

/**
 * Settings for every git call against a third-party repository: no
 * credential helper sends this user's tokens to it, no prompt waits for a
 * password, and no LFS filter runs while checking it out.
 */
const UNTRUSTED_REMOTE = [
  '-c',
  'credential.helper=',
  '-c',
  'core.askPass=true',
  '-c',
  'filter.lfs.smudge=',
  '-c',
  'filter.lfs.process=',
  '-c',
  'filter.lfs.required=false',
  '-c',
  'advice.detachedHead=false',
];

export interface SourceDeps {
  exec: Exec;
  /** `source` → the URL cloned. `githubRemote` on a runner; tests point it at a fixture. */
  remoteOf?: (source: string) => string;
  /** Where temp checkouts go; the OS temp dir by default. */
  tempRoot?: string;
}

export interface Checkout {
  dir: string;
  commit: string;
  dispose: () => Promise<void>;
}

const firstLine = (result: ExecResult | null): string =>
  result
    ? (result.stderr.trim().split('\n').at(-1) ?? '').slice(0, 300)
    : 'git is not available or timed out';

const NOT_FOUND =
  /repository not found|not found|does not appear to be a git repository|could not read username/i;
const MISSING_COMMIT =
  /not our ref|no such remote ref|couldn't find remote ref|unadvertised object|bad object|reference is not a tree/i;

const git = async (
  deps: SourceDeps,
  args: readonly string[],
): Promise<ExecResult | null> =>
  deps.exec('git', [...UNTRUSTED_REMOTE, ...args], {
    timeoutMs: CLONE_TIMEOUT_MS,
  });

const tempCheckout = async (deps: SourceDeps) => {
  const base = await mkdtemp(
    join(deps.tempRoot ?? tmpdir(), 'agentdock-skill-'),
  );
  return {
    base,
    dir: join(base, 'repo'),
    dispose: () => rm(base, { recursive: true, force: true }),
  };
};

const headOf = async (deps: SourceDeps, dir: string): Promise<string> => {
  const head = await deps.exec('git', ['-C', dir, 'rev-parse', 'HEAD']);
  if (!head || head.code !== 0) throw new Error('cannot resolve the commit');
  return head.stdout.trim();
};

/**
 * D2: a shallow clone of the source's default branch, or of `ref`. A
 * repository or ref that does not exist is `not_found`; anything else the
 * forge does wrong is `upstream_unavailable`.
 */
export const cloneSource = async (
  deps: SourceDeps,
  source: string,
  ref?: string,
): Promise<Checkout> => {
  const remote = (deps.remoteOf ?? githubRemote)(source);
  const temp = await tempCheckout(deps);
  try {
    const result = await git(deps, [
      'clone',
      '--quiet',
      '--depth',
      '1',
      '--no-tags',
      ...(ref ? ['--branch', ref] : []),
      '--',
      remote,
      temp.dir,
    ]);
    if (!result || result.code !== 0) {
      const line = firstLine(result);
      throw new CommandFailure(
        result && NOT_FOUND.test(result.stderr)
          ? 'not_found'
          : 'upstream_unavailable',
        `cannot clone ${source}${ref ? ` at ${ref}` : ''}: ${line}`,
      );
    }
    return {
      dir: temp.dir,
      commit: await headOf(deps, temp.dir),
      dispose: temp.dispose,
    };
  } catch (error) {
    await temp.dispose();
    throw error;
  }
};

/**
 * D3: exactly `commit` of the source, fetched alone. A commit the forge no
 * longer serves — the history was rewritten since the preview — is
 * `changed_since_preview`: what was inspected cannot be installed any more.
 */
export const fetchCommit = async (
  deps: SourceDeps,
  source: string,
  commit: string,
): Promise<Checkout> => {
  const remote = (deps.remoteOf ?? githubRemote)(source);
  const temp = await tempCheckout(deps);
  try {
    const init = await deps.exec('git', ['init', '--quiet', temp.dir]);
    if (!init || init.code !== 0)
      throw new Error(`git init failed: ${firstLine(init)}`);
    const fetched = await git(deps, [
      '-C',
      temp.dir,
      'fetch',
      '--quiet',
      '--depth',
      '1',
      '--no-tags',
      '--',
      remote,
      commit,
    ]);
    if (!fetched || fetched.code !== 0) {
      const stderr = fetched?.stderr ?? '';
      if (MISSING_COMMIT.test(stderr)) {
        throw new CommandFailure(
          'changed_since_preview',
          `${source} no longer has commit ${commit}`,
        );
      }
      throw new CommandFailure(
        NOT_FOUND.test(stderr) ? 'not_found' : 'upstream_unavailable',
        `cannot fetch ${source}: ${firstLine(fetched)}`,
      );
    }
    const checkout = await git(deps, [
      '-C',
      temp.dir,
      'checkout',
      '--quiet',
      commit,
    ]);
    if (!checkout || checkout.code !== 0) {
      throw new CommandFailure(
        'changed_since_preview',
        `${source} no longer has commit ${commit}`,
      );
    }
    const head = await headOf(deps, temp.dir);
    if (head !== commit) {
      throw new CommandFailure(
        'changed_since_preview',
        `${source} resolved to ${head}, not ${commit}`,
      );
    }
    return { dir: temp.dir, commit, dispose: temp.dispose };
  } catch (error) {
    await temp.dispose();
    throw error;
  }
};
