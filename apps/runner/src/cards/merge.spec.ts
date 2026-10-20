import { describe, expect, it } from 'bun:test';
import type { CardMergeArgs, WatchedProject } from '@nautelle/shared/protocol';
import { CommandFailure } from '../commands/failure';
import type { ExecResult } from '../detect/exec';
import { mergeCard } from './merge';

/**
 * #273 D11–D13: `card.merge` against a faked `gh` (and the `git remote` the
 * project's GitHub repository is read from). Every call is recorded as the
 * argument array it was spawned with.
 */

const HEAD = 'a'.repeat(40);
const MERGE_COMMIT = 'c'.repeat(40);

const project: WatchedProject = {
  id: 'p1',
  root: '/home/me/widget',
} as WatchedProject;

const args: CardMergeArgs = {
  cardId: 'card_1',
  projectId: 'p1',
  root: '/home/me/widget',
  pr: 41,
  headSha: HEAD,
  method: 'squash',
  issue: 12,
  comment: 'Completed as C-12 on the AgentDock board; merged in #41.',
};

const BRANCH = 'feat/42-export-csv';

interface Fake {
  pr?: {
    state: string;
    headRefOid: string;
    mergeCommit?: { oid: string };
    headRefName?: string;
    baseRefName?: string;
    isCrossRepository?: boolean;
  };
  /** #329 D7: the repository's default branch. */
  defaultBranch?: string;
  /** `gh api repos/…/git/ref/heads/<branch>`; the branch at HEAD by default. */
  ref?: ExecResult;
  /** `gh api -X DELETE …`. */
  del?: ExecResult;
  /** The state after `gh pr merge` succeeds. */
  merge?: ExecResult;
  repo?: Record<string, boolean>;
  issue?: string | null;
  close?: ExecResult;
}

const ok = (stdout: unknown): ExecResult => ({
  code: 0,
  stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
  stderr: '',
});
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr });

const setup = (fake: Fake) => {
  const gh: string[][] = [];
  let merged = false;
  const exec = async (
    binary: string,
    argv: readonly string[],
  ): Promise<ExecResult | null> => {
    if (binary === 'git') {
      return argv.includes('get-url')
        ? ok('git@github.com:acme/widget.git\n')
        : fail('');
    }
    gh.push([...argv]);
    const [noun, verb] = argv;
    if (noun === 'pr' && verb === 'view') {
      const pr = {
        headRefName: BRANCH,
        baseRefName: 'main',
        isCrossRepository: false,
        ...(fake.pr ?? { state: 'OPEN', headRefOid: HEAD }),
      };
      return ok(
        merged
          ? { ...pr, state: 'MERGED', mergeCommit: { oid: MERGE_COMMIT } }
          : pr,
      );
    }
    if (noun === 'pr' && verb === 'merge') {
      const result = fake.merge ?? ok('');
      merged = result.code === 0;
      return result;
    }
    if (noun === 'repo' && verb === 'view') {
      return argv.includes('defaultBranchRef')
        ? ok({ defaultBranchRef: { name: fake.defaultBranch ?? 'main' } })
        : ok(fake.repo ?? {});
    }
    if (noun === 'api') {
      if (argv.includes('DELETE')) return fake.del ?? ok('');
      return fake.ref ?? ok({ object: { sha: fake.pr?.headRefOid ?? HEAD } });
    }
    if (noun === 'issue' && verb === 'view') {
      return fake.issue === null
        ? fail('could not resolve to an issue')
        : ok({ state: fake.issue ?? 'OPEN' });
    }
    if (noun === 'issue' && verb === 'close') return fake.close ?? ok('');
    return fail(`unexpected gh ${argv.join(' ')}`);
  };
  const deps = { exec, watchedProjects: () => [project] };
  const calls = (noun: string, verb: string) =>
    gh.filter((c) => c[0] === noun && c[1] === verb);
  return { deps, gh, calls };
};

describe('card.merge (#273 D11–D13)', () => {
  it('merges with the method, bound to the head, as an argument array', async () => {
    const { deps, calls } = setup({});
    expect(await mergeCard(args, deps)).toEqual({
      merged: true,
      alreadyMerged: false,
      method: 'squash',
      mergeCommit: MERGE_COMMIT,
      issueClosed: true,
      branchDeleted: false,
    });
    expect(calls('pr', 'merge')).toEqual([
      [
        'pr',
        'merge',
        '41',
        '--repo',
        'acme/widget',
        '--squash',
        '--match-head-commit',
        HEAD,
      ],
    ]);
  });

  it('never deletes the branch (D15)', async () => {
    const { deps, gh } = setup({});
    await mergeCard(args, deps);
    expect(gh.flat()).not.toContain('--delete-branch');
    expect(gh.flat()).not.toContain('-d');
  });

  it('refuses a mismatched head as head_changed without merging', async () => {
    const { deps, calls } = setup({
      pr: { state: 'OPEN', headRefOid: 'b'.repeat(40) },
    });
    const result = await mergeCard(args, deps);
    expect(result).toMatchObject({ merged: false, error: 'head_changed' });
    expect(calls('pr', 'merge')).toEqual([]);
    expect(calls('issue', 'close')).toEqual([]);
  });

  it('answers alreadyMerged for a merged PR, with no merge call, and still closes the issue', async () => {
    const { deps, calls } = setup({
      pr: {
        state: 'MERGED',
        headRefOid: 'b'.repeat(40),
        mergeCommit: { oid: MERGE_COMMIT },
      },
    });
    expect(await mergeCard(args, deps)).toEqual({
      merged: true,
      alreadyMerged: true,
      method: 'squash',
      mergeCommit: MERGE_COMMIT,
      issueClosed: true,
      branchDeleted: false,
    });
    expect(calls('pr', 'merge')).toEqual([]);
    expect(calls('issue', 'close')).toHaveLength(1);
  });

  it('refuses a closed PR', async () => {
    const { deps, calls } = setup({
      pr: { state: 'CLOSED', headRefOid: HEAD },
    });
    expect(await mergeCard(args, deps)).toMatchObject({
      merged: false,
      error: 'closed',
    });
    expect(calls('pr', 'merge')).toEqual([]);
  });

  it('method null picks from gh repo view in merge → squash → rebase order', async () => {
    for (const [repo, method] of [
      [
        {
          mergeCommitAllowed: true,
          squashMergeAllowed: true,
          rebaseMergeAllowed: true,
        },
        'merge',
      ],
      [
        {
          mergeCommitAllowed: false,
          squashMergeAllowed: true,
          rebaseMergeAllowed: true,
        },
        'squash',
      ],
      [
        {
          mergeCommitAllowed: false,
          squashMergeAllowed: false,
          rebaseMergeAllowed: true,
        },
        'rebase',
      ],
    ] as const) {
      const { deps, calls } = setup({ repo });
      const result = await mergeCard({ ...args, method: null }, deps);
      expect(result).toMatchObject({ merged: true, method });
      expect(calls('repo', 'view')[0]).toEqual([
        'repo',
        'view',
        'acme/widget',
        '--json',
        'mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed',
      ]);
      expect(calls('pr', 'merge')[0]).toContain(`--${method}`);
    }
  });

  it('does not read the repository when the method is given', async () => {
    const { deps, calls } = setup({});
    await mergeCard(args, deps);
    expect(calls('repo', 'view')).toEqual([]);
  });

  it('closes an open issue with the comment', async () => {
    const { deps, calls } = setup({ issue: 'OPEN' });
    await mergeCard(args, deps);
    expect(calls('issue', 'close')).toEqual([
      [
        'issue',
        'close',
        '12',
        '--repo',
        'acme/widget',
        '--reason',
        'completed',
        '--comment',
        args.comment,
      ],
    ]);
  });

  it('leaves a closed issue alone', async () => {
    const { deps, calls } = setup({ issue: 'CLOSED' });
    expect(await mergeCard(args, deps)).toMatchObject({ issueClosed: true });
    expect(calls('issue', 'close')).toEqual([]);
  });

  it('touches no issue when the card has none', async () => {
    const { deps, calls } = setup({});
    expect(await mergeCard({ ...args, issue: null }, deps)).toMatchObject({
      merged: true,
      issueClosed: false,
    });
    expect(calls('issue', 'view')).toEqual([]);
  });

  it('an issue-close failure still returns merged: true, issueClosed: false', async () => {
    const { deps } = setup({
      close: fail('HTTP 403: Resource not accessible'),
    });
    const result = await mergeCard(args, deps);
    expect(result).toEqual({
      merged: true,
      alreadyMerged: false,
      method: 'squash',
      mergeCommit: MERGE_COMMIT,
      issueClosed: false,
      issueError: 'HTTP 403: Resource not accessible',
      branchDeleted: false,
    });
  });

  it('classifies a refused gh pr merge', async () => {
    for (const [stderr, reason] of [
      [
        'X Pull request acme/widget#41 is not mergeable: the base branch policy prohibits the merge.',
        'not_mergeable',
      ],
      ['GraphQL: Required status check "ci" is expected.', 'not_mergeable'],
      [
        'GraphQL: Head branch was modified. Review and try the merge again.',
        'head_changed',
      ],
      ['HTTP 502: Bad Gateway', 'gh_failed'],
    ] as const) {
      const { deps, calls } = setup({ merge: fail(`${stderr}\nmore`) });
      expect(await mergeCard(args, deps)).toEqual({
        merged: false,
        error: reason,
        message: stderr,
      });
      expect(calls('issue', 'close')).toEqual([]);
    }
  });

  it('refuses gh_failed when the PR cannot be read', async () => {
    const { deps } = setup({});
    const exec = deps.exec;
    const result = await mergeCard(args, {
      ...deps,
      exec: async (binary, argv) =>
        binary === 'gh' && argv[1] === 'view'
          ? fail('gh: authentication required')
          : exec(binary, argv),
    });
    expect(result).toEqual({
      merged: false,
      error: 'gh_failed',
      message: 'gh: authentication required',
    });
  });

  it('refuses a root that is not the watched project, before any gh call', async () => {
    const { deps, gh } = setup({});
    await expect(
      mergeCard({ ...args, root: '/home/me/other' }, deps),
    ).rejects.toBeInstanceOf(CommandFailure);
    expect(gh).toEqual([]);
  });
});

describe('card.merge deleteBranch (#329 D7)', () => {
  const del = [
    'api',
    '-X',
    'DELETE',
    `repos/acme/widget/git/refs/heads/${BRANCH}`,
  ];
  const deleteArgs: CardMergeArgs = { ...args, deleteBranch: true };

  it('deletes the PR head on GitHub only after the merge succeeded', async () => {
    const { deps, gh } = setup({});
    expect(await mergeCard(deleteArgs, deps)).toMatchObject({
      merged: true,
      alreadyMerged: false,
      branchDeleted: true,
    });
    const merged = gh.findIndex((c) => c[0] === 'pr' && c[1] === 'merge');
    const deleted = gh.findIndex((c) => c.join(' ') === del.join(' '));
    expect(merged).toBeGreaterThanOrEqual(0);
    expect(deleted).toBeGreaterThan(merged);
    expect(gh[0]).toEqual(
      expect.arrayContaining([
        '--json',
        'state,mergeCommit,headRefName,headRefOid,baseRefName,isCrossRepository',
      ]),
    );
  });

  it('a refused merge deletes nothing', async () => {
    const { deps, calls } = setup({ merge: fail('not mergeable') });
    expect(await mergeCard(deleteArgs, deps)).toMatchObject({ merged: false });
    expect(calls('api', '-X')).toEqual([]);
  });

  it('deletes the head of a PR merged before', async () => {
    const { deps, gh } = setup({
      pr: {
        state: 'MERGED',
        headRefOid: HEAD,
        mergeCommit: { oid: MERGE_COMMIT },
      },
    });
    expect(await mergeCard(deleteArgs, deps)).toMatchObject({
      alreadyMerged: true,
      branchDeleted: true,
    });
    expect(gh).toContainEqual(del);
  });

  it('never deletes the base, the default branch or a fork head', async () => {
    for (const fake of [
      {
        pr: {
          state: 'OPEN',
          headRefOid: HEAD,
          headRefName: 'main',
          baseRefName: 'main',
        },
      },
      {
        pr: {
          state: 'OPEN',
          headRefOid: HEAD,
          headRefName: 'develop',
          baseRefName: 'release',
        },
        defaultBranch: 'develop',
      },
      { pr: { state: 'OPEN', headRefOid: HEAD, isCrossRepository: true } },
    ] satisfies Fake[]) {
      const { deps, calls } = setup(fake);
      const result = await mergeCard(deleteArgs, deps);
      expect(result).toMatchObject({
        merged: true,
        branchDeleted: false,
        branchError: expect.stringContaining('left in place'),
      });
      expect(calls('api', '-X')).toEqual([]);
    }
  });

  it('leaves a branch that moved past the PR head', async () => {
    const { deps, calls } = setup({
      ref: ok({ object: { sha: 'd'.repeat(40) } }),
    });
    expect(await mergeCard(deleteArgs, deps)).toMatchObject({
      merged: true,
      branchDeleted: false,
      branchError: expect.stringContaining('moved past'),
    });
    expect(calls('api', '-X')).toEqual([]);
  });

  it('a branch already gone is deleted; a refused deletion keeps the merge', async () => {
    const gone = setup({ ref: fail('gh: Not Found (HTTP 404)') });
    expect(await mergeCard(deleteArgs, gone.deps)).toMatchObject({
      merged: true,
      branchDeleted: true,
    });
    expect(gone.calls('api', '-X')).toEqual([]);

    const refused = setup({ del: fail('HTTP 403: Resource not accessible') });
    expect(await mergeCard(deleteArgs, refused.deps)).toEqual({
      merged: true,
      alreadyMerged: false,
      method: 'squash',
      mergeCommit: MERGE_COMMIT,
      issueClosed: true,
      branchDeleted: false,
      branchError: 'HTTP 403: Resource not accessible',
    });
  });

  it('encodes a branch name into the ref path', async () => {
    const { deps, gh } = setup({
      pr: { state: 'OPEN', headRefOid: HEAD, headRefName: 'fix/a#b' },
    });
    await mergeCard(deleteArgs, deps);
    expect(gh).toContainEqual([
      'api',
      '-X',
      'DELETE',
      'repos/acme/widget/git/refs/heads/fix/a%23b',
    ]);
  });
});
