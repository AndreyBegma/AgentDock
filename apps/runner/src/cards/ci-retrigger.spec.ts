import { describe, expect, it } from 'bun:test';
import {
  type CardCiRetriggerArgs,
  cardCiRetriggerResultSchema,
  type WatchedProject,
} from '@agentdock/shared/protocol';
import type { ExecResult } from '../detect/exec';
import { ciRetriggerComment, retriggerCardCi } from './ci-retrigger';

/**
 * #484: `card.ciRetrigger` against a faked `gh` (and the `git remote` the
 * project's GitHub repository is read from).
 */

const HEAD = 'b'.repeat(40);

const project = { id: 'p1', root: '/home/me/widget' } as WatchedProject;

const args: CardCiRetriggerArgs = {
  cardId: 'card_1',
  projectId: 'p1',
  root: '/home/me/widget',
  pr: 41,
  headSha: HEAD,
};

const ok = (stdout: unknown = ''): ExecResult => ({
  code: 0,
  stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
  stderr: '',
});

const fail = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr });

interface Fake {
  view?: ExecResult;
  close?: ExecResult;
  reopen?: ExecResult[];
}

const setup = (fake: Fake) => {
  const gh: string[][] = [];
  const reopens = [...(fake.reopen ?? [])];
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
    if (argv[1] === 'view') {
      return fake.view ?? ok({ state: 'OPEN', headRefOid: HEAD });
    }
    if (argv[1] === 'close') return fake.close ?? ok();
    if (argv[1] === 'reopen') return reopens.shift() ?? ok();
    return fail('unsupported');
  };
  const run = (a: CardCiRetriggerArgs = args) =>
    retriggerCardCi(a, { exec, watchedProjects: () => [project] });
  return { gh, run };
};

describe('card.ciRetrigger (#484)', () => {
  it('closes and reopens the PR with argument arrays, the reopen explained', async () => {
    const t = setup({});
    const result = await t.run();
    expect(result).toEqual({ retriggered: true });
    expect(cardCiRetriggerResultSchema.safeParse(result).success).toBe(true);
    expect(t.gh).toEqual([
      [
        'pr',
        'view',
        '41',
        '--repo',
        'acme/widget',
        '--json',
        'state,headRefOid',
      ],
      ['pr', 'close', '41', '--repo', 'acme/widget'],
      [
        'pr',
        'reopen',
        '41',
        '--repo',
        'acme/widget',
        '--comment',
        ciRetriggerComment(HEAD),
      ],
    ]);
  });

  it('leaves a merged or closed PR alone', async () => {
    for (const state of ['MERGED', 'CLOSED']) {
      const t = setup({ view: ok({ state, headRefOid: HEAD }) });
      const result = await t.run();
      expect(result).toMatchObject({ retriggered: false, error: 'not_open' });
      expect(t.gh).toHaveLength(1);
    }
  });

  it('leaves a PR whose head moved on alone — the new head has its own event', async () => {
    const t = setup({
      view: ok({ state: 'OPEN', headRefOid: 'c'.repeat(40) }),
    });
    expect(await t.run()).toMatchObject({
      retriggered: false,
      error: 'head_moved',
    });
    expect(t.gh).toHaveLength(1);
  });

  it('reports a view or close gh could not do, and closes nothing more', async () => {
    const viewFails = setup({ view: fail('HTTP 502: Bad Gateway') });
    expect(await viewFails.run()).toEqual({
      retriggered: false,
      error: 'gh_failed',
      message: 'HTTP 502: Bad Gateway',
    });
    expect(viewFails.gh).toHaveLength(1);

    const closeFails = setup({ close: fail('HTTP 403: forbidden') });
    expect(await closeFails.run()).toMatchObject({
      retriggered: false,
      error: 'gh_failed',
    });
    expect(closeFails.gh.map((a) => a[1])).toEqual(['view', 'close']);
  });

  it('tries the reopen twice, and says so when the PR stays closed', async () => {
    const flaky = setup({ reopen: [fail('HTTP 502'), ok()] });
    expect(await flaky.run()).toEqual({ retriggered: true });
    expect(flaky.gh.map((a) => a[1])).toEqual([
      'view',
      'close',
      'reopen',
      'reopen',
    ]);

    const down = setup({ reopen: [fail('HTTP 502'), fail('HTTP 503')] });
    expect(await down.run()).toEqual({
      retriggered: false,
      error: 'reopen_failed',
      message: 'HTTP 503',
    });
  });
});
