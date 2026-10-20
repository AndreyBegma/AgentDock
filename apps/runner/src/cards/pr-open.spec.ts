import { describe, expect, it } from 'bun:test';
import {
  type CardPrOpenArgs,
  cardPrOpenArgsSchema,
  cardPrOpenResultSchema,
  type WatchedProject,
} from '@agentdock/shared/protocol';
import type { ExecResult } from '../detect/exec';
import { openCardPr } from './pr-open';

/**
 * #709: `card.prOpen` against a faked `gh` (and the `git remote` the
 * project's GitHub repository is read from).
 */

const project = { id: 'p1', root: '/home/me/widget' } as WatchedProject;

const args: CardPrOpenArgs = {
  cardId: 'card_2',
  projectId: 'p1',
  root: '/home/me/widget',
  branch: 'feat/2-the-dependant',
  base: 'develop',
  title: 'C-2: The dependant',
  body: 'Forward of #78.',
};

const ok = (stdout: unknown = ''): ExecResult => ({
  code: 0,
  stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
  stderr: '',
});

const fail = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr });

interface Fake {
  list?: ExecResult;
  create?: ExecResult;
  view?: ExecResult;
}

const setup = (fake: Fake) => {
  const gh: string[][] = [];
  const exec = async (
    binary: string,
    argv: readonly string[],
  ): Promise<ExecResult | null> => {
    if (binary === 'git') {
      return argv.includes('get-url')
        ? ok('git@github.com:acme/widget.git\n')
        : { code: 1, stdout: '', stderr: '' };
    }
    gh.push([...argv]);
    if (argv[1] === 'list') return fake.list ?? ok([]);
    if (argv[1] === 'create') {
      return fake.create ?? ok('https://github.com/acme/widget/pull/91\n');
    }
    if (argv[1] === 'view') return fake.view ?? ok({ mergeable: 'MERGEABLE' });
    return fail('unsupported');
  };
  const run = (a: CardPrOpenArgs = args) =>
    openCardPr(a, { exec, watchedProjects: () => [project] });
  return { gh, run };
};

describe('card.prOpen (#709)', () => {
  it('opens a PR of the branch into the base with argument arrays', async () => {
    const t = setup({});
    const result = await t.run();
    expect(result).toEqual({
      opened: true,
      prNumber: 91,
      prUrl: 'https://github.com/acme/widget/pull/91',
      alreadyOpen: false,
      mergeable: 'MERGEABLE',
    });
    expect(cardPrOpenResultSchema.safeParse(result).success).toBe(true);
    expect(t.gh[0]).toEqual([
      'pr',
      'list',
      '--repo',
      'acme/widget',
      '--head',
      'feat/2-the-dependant',
      '--base',
      'develop',
      '--state',
      'open',
      '--json',
      'number,url',
      '--limit',
      '1',
    ]);
    const create = t.gh[1] ?? [];
    expect(create.slice(0, 10)).toEqual([
      'pr',
      'create',
      '--repo',
      'acme/widget',
      '--base',
      'develop',
      '--head',
      'feat/2-the-dependant',
      '--title',
      'C-2: The dependant',
    ]);
    // The body goes through a file, never argv.
    expect(create).not.toContain('Forward of #78.');
    expect(t.gh[2]).toEqual([
      'pr',
      'view',
      '91',
      '--repo',
      'acme/widget',
      '--json',
      'mergeable',
    ]);
  });

  it('reuses an open PR of the branch into the base and reports a conflict', async () => {
    const t = setup({
      list: ok([{ number: 88, url: 'https://github.com/acme/widget/pull/88' }]),
      view: ok({ mergeable: 'CONFLICTING' }),
    });
    expect(await t.run()).toEqual({
      opened: true,
      prNumber: 88,
      prUrl: 'https://github.com/acme/widget/pull/88',
      alreadyOpen: true,
      mergeable: 'CONFLICTING',
    });
    expect(t.gh.map((a) => a[1])).toEqual(['list', 'view']);
  });

  it('classifies what GitHub refuses', async () => {
    const noCommits = setup({
      create: fail(
        'pull request create failed: GraphQL: No commits between develop and feat/2-the-dependant (createPullRequest)',
      ),
    });
    expect(await noCommits.run()).toMatchObject({
      opened: false,
      error: 'no_commits',
    });

    const noBranch = setup({
      create: fail(
        "pull request create failed: GraphQL: Head sha can't be blank, Base sha can't be blank, No commits between develop and feat/2-the-dependant, Head ref must be a branch (createPullRequest)",
      ),
    });
    expect(await noBranch.run()).toMatchObject({
      opened: false,
      error: 'no_branch',
    });

    const listFails = setup({ list: fail('HTTP 502: Bad Gateway') });
    expect(await listFails.run()).toEqual({
      opened: false,
      error: 'gh_failed',
      message: 'HTTP 502: Bad Gateway',
    });
    expect(listFails.gh).toHaveLength(1);
  });

  it('an unreadable mergeable is UNKNOWN', async () => {
    const t = setup({ view: fail('HTTP 502') });
    expect(await t.run()).toMatchObject({ opened: true, mergeable: 'UNKNOWN' });
  });

  it('takes no branch or base that is not a branch name', () => {
    for (const ref of ['--force', 'a..b', '']) {
      expect(
        cardPrOpenArgsSchema.safeParse({ ...args, base: ref }).success,
      ).toBe(false);
      expect(
        cardPrOpenArgsSchema.safeParse({ ...args, branch: ref }).success,
      ).toBe(false);
    }
  });
});
