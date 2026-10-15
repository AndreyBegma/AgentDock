import { describe, expect, it } from 'bun:test';
import type {
  CardPrCloseArgs,
  WatchedProject,
} from '@agentdock/shared/protocol';
import { cardPrCloseResultSchema } from '@agentdock/shared/protocol';
import { CommandFailure } from '../commands/failure';
import type { ExecResult } from '../detect/exec';
import { closeCardPr } from './pr-close';

/**
 * #329 D8: `card.prClose` against a faked `gh` (and the `git remote` the
 * project's GitHub repository is read from). Every `gh` call is recorded as
 * the argument array it was spawned with.
 */

const HEAD = 'a'.repeat(40);
const BRANCH = 'feat/42-export-csv';

const project: WatchedProject = {
  id: 'p1',
  root: '/home/me/widget',
} as WatchedProject;

const args: CardPrCloseArgs = {
  cardId: 'card_1',
  projectId: 'p1',
  root: '/home/me/widget',
  pr: 41,
  deleteBranch: true,
  issue: null,
  comment: 'Closed from the AgentDock Board (C-12)',
};

interface Fake {
  state?: string;
  view?: ExecResult;
  close?: ExecResult;
  issue?: string;
  issueClose?: ExecResult;
  del?: ExecResult;
}

const ok = (stdout: unknown): ExecResult => ({
  code: 0,
  stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
  stderr: '',
});
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr });

const setup = (fake: Fake) => {
  const gh: string[][] = [];
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
      return (
        fake.view ??
        ok({
          state: fake.state ?? 'OPEN',
          headRefName: BRANCH,
          headRefOid: HEAD,
          baseRefName: 'main',
          isCrossRepository: false,
        })
      );
    }
    if (noun === 'pr' && verb === 'close') return fake.close ?? ok('');
    if (noun === 'repo' && verb === 'view') {
      return ok({ defaultBranchRef: { name: 'main' } });
    }
    if (noun === 'api') {
      return argv.includes('DELETE')
        ? (fake.del ?? ok(''))
        : ok({ object: { sha: HEAD } });
    }
    if (noun === 'issue' && verb === 'view') {
      return ok({ state: fake.issue ?? 'OPEN' });
    }
    if (noun === 'issue' && verb === 'close') return fake.issueClose ?? ok('');
    return fail(`unexpected gh ${argv.join(' ')}`);
  };
  const deps = { exec, watchedProjects: () => [project] };
  const calls = (noun: string, verb: string) =>
    gh.filter((c) => c[0] === noun && c[1] === verb);
  return { deps, gh, calls };
};

const DELETE = [
  'api',
  '-X',
  'DELETE',
  `repos/acme/widget/git/refs/heads/${BRANCH}`,
];

describe('card.prClose (#329 D8)', () => {
  it('closes the PR with the comment, then deletes its head branch', async () => {
    const { deps, gh, calls } = setup({});
    const result = await closeCardPr(args, deps);
    expect(result).toEqual({
      closed: true,
      alreadyClosed: false,
      branchDeleted: true,
      issueClosed: false,
    });
    expect(cardPrCloseResultSchema.safeParse(result).success).toBe(true);
    expect(calls('pr', 'close')).toEqual([
      [
        'pr',
        'close',
        '41',
        '--repo',
        'acme/widget',
        '--comment',
        'Closed from the AgentDock Board (C-12)',
      ],
    ]);
    const closed = gh.findIndex((c) => c[0] === 'pr' && c[1] === 'close');
    const deleted = gh.findIndex((c) => c.join(' ') === DELETE.join(' '));
    expect(deleted).toBeGreaterThan(closed);
    expect(calls('issue', 'view')).toEqual([]);
  });

  it('without deleteBranch, only closes', async () => {
    const { deps, calls } = setup({});
    expect(
      await closeCardPr({ ...args, deleteBranch: false }, deps),
    ).toMatchObject({ closed: true, branchDeleted: false });
    expect(calls('api', '-X')).toEqual([]);
    expect(calls('repo', 'view')).toEqual([]);
  });

  it('refuses a merged PR and touches nothing', async () => {
    const { deps, gh } = setup({ state: 'MERGED' });
    expect(await closeCardPr({ ...args, issue: 12 }, deps)).toEqual({
      closed: false,
      error: 'merged',
      message: 'pull request #41 is merged',
    });
    expect(gh).toHaveLength(1);
  });

  it('a PR closed before is a success, and the branch and issue steps still run', async () => {
    const { deps, gh, calls } = setup({ state: 'CLOSED' });
    expect(await closeCardPr({ ...args, issue: 12 }, deps)).toEqual({
      closed: true,
      alreadyClosed: true,
      branchDeleted: true,
      issueClosed: true,
    });
    expect(calls('pr', 'close')).toEqual([]);
    expect(gh).toContainEqual(DELETE);
  });

  it('a refused gh pr close is gh_failed: no branch, no issue', async () => {
    const { deps, calls } = setup({
      close: fail('HTTP 403: Resource not accessible\nmore'),
    });
    expect(await closeCardPr({ ...args, issue: 12 }, deps)).toEqual({
      closed: false,
      error: 'gh_failed',
      message: 'HTTP 403: Resource not accessible',
    });
    expect(calls('api', '-X')).toEqual([]);
    expect(calls('issue', 'close')).toEqual([]);
  });

  it('an unreadable PR is gh_failed', async () => {
    const { deps, calls } = setup({
      view: fail('gh: authentication required'),
    });
    expect(await closeCardPr(args, deps)).toEqual({
      closed: false,
      error: 'gh_failed',
      message: 'gh: authentication required',
    });
    expect(calls('pr', 'close')).toEqual([]);
  });

  it('closes the issue as not planned only when asked and still open', async () => {
    const asked = setup({});
    expect(await closeCardPr({ ...args, issue: 12 }, asked.deps)).toMatchObject(
      { issueClosed: true },
    );
    expect(asked.calls('issue', 'close')).toEqual([
      [
        'issue',
        'close',
        '12',
        '--repo',
        'acme/widget',
        '--reason',
        'not planned',
        '--comment',
        'Closed from the AgentDock Board (C-12)',
      ],
    ]);

    const closedBefore = setup({ issue: 'CLOSED' });
    expect(
      await closeCardPr({ ...args, issue: 12 }, closedBefore.deps),
    ).toMatchObject({ issueClosed: false });
    expect(closedBefore.calls('issue', 'close')).toEqual([]);
  });

  it('a failed branch or issue step is reported; the PR stays closed', async () => {
    const { deps } = setup({
      del: fail('HTTP 403: branch protected'),
      issueClose: fail('HTTP 502: Bad Gateway'),
    });
    expect(await closeCardPr({ ...args, issue: 12 }, deps)).toEqual({
      closed: true,
      alreadyClosed: false,
      branchDeleted: false,
      branchError: 'HTTP 403: branch protected',
      issueClosed: false,
      issueError: 'HTTP 502: Bad Gateway',
    });
  });

  it('refuses a root that is not the watched project, before any gh call', async () => {
    const { deps, gh } = setup({});
    await expect(
      closeCardPr({ ...args, root: '/home/me/other' }, deps),
    ).rejects.toBeInstanceOf(CommandFailure);
    expect(gh).toEqual([]);
  });
});
