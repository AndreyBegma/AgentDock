import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { cardWipCommitMessage } from '@agentdock/shared';
import type {
  CardCollectArgs,
  CardCollectPrState,
  CardCollectResult,
  CardRunFile,
} from '@agentdock/shared/protocol';
import { z } from 'zod';
import { CommandFailure } from '../commands/failure';
import {
  GH_TIMEOUT_MS,
  gitOk,
  gitSucceeds,
  NETWORK_TIMEOUT_MS,
  NO_HOOKS,
  type SkillsDeps,
  stderrLine,
} from '../skills/deps';
import { createPullRequest, githubOf, pushBranch } from '../skills/run/collect';
import type { CardRecord } from './record';

export type GitDeps = Pick<SkillsDeps, 'exec' | 'tempRoot'>;

/**
 * #309 D9: adds `pattern` to the worktree's git exclude (`info/exclude`, which
 * git reads for every worktree of the repository) unless a line already has
 * it, so `git status` and `add -A` never see the runner's own files.
 */
export const excludeFromGit = async (
  deps: GitDeps,
  worktree: string,
  pattern: string,
): Promise<void> => {
  const path = (
    await gitOk(deps.exec, [
      '-C',
      worktree,
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'info/exclude',
    ])
  ).trim();
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (current.split('\n').some((line) => line.trim() === pattern)) return;
  mkdirSync(dirname(path), { recursive: true });
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  appendFileSync(path, `${separator}${pattern}\n`);
};

/** The commit of a ref, or null when it does not exist. */
const commitOf = async (
  deps: GitDeps,
  root: string,
  ref: string,
): Promise<string | null> => {
  const result = await deps.exec('git', [
    '-C',
    root,
    'rev-parse',
    '--verify',
    '--quiet',
    `${ref}^{commit}`,
  ]);
  return result?.code === 0 ? result.stdout.trim() : null;
};

/** Best effort: an unreachable origin still works from what it last fetched. */
const fetchRef = (deps: GitDeps, root: string, ref: string) =>
  deps.exec('git', ['-C', root, 'fetch', '--quiet', 'origin', ref], {
    timeoutMs: NETWORK_TIMEOUT_MS,
  });

/**
 * D5: the card's worktree, created when it is missing — on round 1, and on a
 * round after `card.close` removed it. The branch is the local one when it
 * survived, else `origin/<branch>` when it was pushed, else a new branch from
 * `origin/<base>`.
 */
export const ensureWorktree = async (
  deps: GitDeps,
  record: Pick<CardRecord, 'root' | 'worktree' | 'branch' | 'base'>,
): Promise<'existing' | 'created'> => {
  const { root, worktree, branch, base } = record;
  if (existsSync(worktree)) return 'existing';
  await fetchRef(deps, root, base);
  await fetchRef(deps, root, branch);
  if (await commitOf(deps, root, `refs/heads/${branch}`)) {
    await gitOk(deps.exec, [
      '-C',
      root,
      'worktree',
      'add',
      '--quiet',
      worktree,
      branch,
    ]);
    return 'created';
  }
  const start =
    (await commitOf(deps, root, `refs/remotes/origin/${branch}`)) ??
    (await commitOf(deps, root, `refs/remotes/origin/${base}`));
  if (!start) throw new Error(`origin/${base} does not exist`);
  await gitOk(deps.exec, [
    '-C',
    root,
    'worktree',
    'add',
    '--quiet',
    '--no-track',
    '-b',
    branch,
    worktree,
    start,
  ]);
  return 'created';
};

const isWithin = (path: string, dir: string): boolean =>
  path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);

/**
 * D2: writes the card's `files` (its spec) into the worktree and commits them
 * as their own commit, without the project's hooks. A path into `.git`, or
 * one that leaves the worktree through a symlink, is refused. Files already
 * committed with the same content make no commit.
 */
export const commitFiles = async (
  deps: GitDeps,
  worktree: string,
  files: readonly CardRunFile[],
): Promise<boolean> => {
  if (files.length === 0) return false;
  const top = realpathSync(worktree);
  for (const file of files) {
    if (file.path.split('/')[0] === '.git') {
      throw new CommandFailure(
        'path_not_allowed',
        `${file.path} is inside .git`,
      );
    }
    const target = join(top, file.path);
    mkdirSync(dirname(target), { recursive: true });
    const parent = realpathSync(dirname(target));
    const link = existsSync(target) && lstatSync(target).isSymbolicLink();
    if (!isWithin(parent, top) || link) {
      throw new CommandFailure(
        'path_not_allowed',
        `${file.path} leaves the card's worktree`,
      );
    }
    writeFileSync(target, file.content, { mode: 0o644 });
  }
  const paths = files.map((f) => f.path);
  await gitOk(deps.exec, ['-C', top, 'add', '--', ...paths]);
  if (await gitSucceeds(deps.exec, ['-C', top, 'diff', '--cached', '--quiet']))
    return false;
  await gitOk(deps.exec, [
    '-C',
    top,
    ...NO_HOOKS,
    'commit',
    '--quiet',
    '--no-verify',
    '-m',
    `docs: add ${paths.join(', ')}`,
  ]);
  return true;
};

const openPrSchema = z.array(
  z.object({
    number: z.number().int().positive(),
    url: z.string().min(1),
    isDraft: z.boolean().optional(),
  }),
);

interface OpenPr {
  number: number;
  url: string;
  state: CardCollectPrState;
}

/** The open PR of `branch`, or null; throws when `gh` cannot answer. */
const openPullRequest = async (
  deps: GitDeps,
  github: string,
  branch: string,
): Promise<OpenPr | null> => {
  const listed = await deps.exec(
    'gh',
    [
      'pr',
      'list',
      '--repo',
      github,
      '--head',
      branch,
      '--state',
      'open',
      '--json',
      'number,url,isDraft',
      '--limit',
      '1',
    ],
    { timeoutMs: GH_TIMEOUT_MS },
  );
  if (!listed || listed.code !== 0) {
    throw new Error(`gh pr list failed: ${stderrLine(listed)}`);
  }
  const parsed = openPrSchema.safeParse(JSON.parse(listed.stdout || '[]'));
  if (!parsed.success) throw new Error('gh pr list printed no PR list');
  const pr = parsed.data[0];
  if (!pr) return null;
  return {
    number: pr.number,
    url: pr.url,
    state: pr.isDraft ? 'draft' : 'open',
  };
};

/**
 * D8: commit the leftovers, push, and open a PR into the base unless one is
 * open for the branch already — then it is only pushed. Nothing ahead of
 * `origin/<base>` is "No changes": nothing is pushed or opened. The checkout
 * must be on `branch` — a session that switched branches (#282 D3) is
 * `invalid_args`, so nothing is committed to a branch the API did not name.
 */
export const collectCard = async (
  deps: GitDeps,
  record: Pick<CardRecord, 'projectId' | 'root' | 'worktree' | 'branch'>,
  args: CardCollectArgs,
): Promise<CardCollectResult> => {
  const wt = record.worktree;
  const head = await deps.exec('git', [
    '-C',
    wt,
    'symbolic-ref',
    '--quiet',
    '--short',
    'HEAD',
  ]);
  const current = head?.code === 0 ? head.stdout.trim() : null;
  if (current !== record.branch) {
    throw new CommandFailure(
      'invalid_args',
      `${wt} is on ${current ?? 'a detached HEAD'}, not ${record.branch}`,
    );
  }
  await gitOk(deps.exec, ['-C', wt, 'add', '-A']);
  if (
    !(await gitSucceeds(deps.exec, ['-C', wt, 'diff', '--cached', '--quiet']))
  ) {
    await gitOk(deps.exec, [
      '-C',
      wt,
      ...NO_HOOKS,
      'commit',
      '--quiet',
      '--no-verify',
      '-m',
      cardWipCommitMessage(args.number),
    ]);
  }
  await fetchRef(deps, record.root, args.base);
  const ahead = Number(
    (
      await gitOk(deps.exec, [
        '-C',
        wt,
        'rev-list',
        '--count',
        `refs/remotes/origin/${args.base}..HEAD`,
      ])
    ).trim(),
  );
  if (!(ahead > 0)) return { ahead: 0, pushed: false };
  const github = await githubOf(deps, {
    id: record.projectId,
    root: record.root,
  });
  await pushBranch(deps, wt, record.branch);
  // #329 D3: an open PR is reported whether this collect opened it or not,
  // so the API fills a link it lost.
  const pr: OpenPr = (await openPullRequest(deps, github, record.branch)) ?? {
    ...(await createPullRequest(deps, {
      github,
      base: args.base,
      branch: record.branch,
      title: args.title,
      body: args.body,
    })),
    state: 'open',
  };
  return {
    ahead,
    pushed: true,
    prNumber: pr.number,
    prUrl: pr.url,
    prState: pr.state,
  };
};

/**
 * D10: removes the card's worktree, and its local branch only when every
 * commit of it is on `origin/<branch>` — unpushed work is never deleted.
 */
export const removeCardWorktree = async (
  deps: GitDeps,
  record: Pick<CardRecord, 'root' | 'worktree' | 'branch'>,
): Promise<{ worktreeRemoved: boolean; branchDeleted: boolean }> => {
  const { root, worktree, branch } = record;
  let worktreeRemoved = false;
  if (existsSync(worktree)) {
    await gitOk(deps.exec, [
      '-C',
      root,
      'worktree',
      'remove',
      '--force',
      worktree,
    ]);
    worktreeRemoved = true;
  }
  await fetchRef(deps, root, branch);
  const local = await commitOf(deps, root, `refs/heads/${branch}`);
  const remote = await commitOf(deps, root, `refs/remotes/origin/${branch}`);
  if (!local || !remote) return { worktreeRemoved, branchDeleted: false };
  const pushed = await gitSucceeds(deps.exec, [
    '-C',
    root,
    'merge-base',
    '--is-ancestor',
    local,
    remote,
  ]);
  if (!pushed) return { worktreeRemoved, branchDeleted: false };
  await gitOk(deps.exec, ['-C', root, 'branch', '--quiet', '-D', branch]);
  return { worktreeRemoved, branchDeleted: true };
};
