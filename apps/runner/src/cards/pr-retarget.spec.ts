import { describe, expect, it } from 'bun:test';
import {
  type CardPrRetargetArgs,
  cardPrRetargetArgsSchema,
  cardPrRetargetResultSchema,
  type WatchedProject,
} from '@agentdock/shared/protocol';
import type { ExecResult } from '../detect/exec';
import { retargetCardPr } from './pr-retarget';

/**
 * #636: `card.prRetarget` against a faked `gh` (and the `git remote` the
 * project's GitHub repository is read from).
 */

const project = { id: 'p1', root: '/home/me/widget' } as WatchedProject;

const args: CardPrRetargetArgs = {
  cardId: 'card_2',
  projectId: 'p1',
  root: '/home/me/widget',
  pr: 42,
  base: 'develop',
};

const ok = (stdout: unknown = ''): ExecResult => ({
  code: 0,
  stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
  stderr: '',
});

const fail = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr });

interface Fake {
  view?: ExecResult;
  edit?: ExecResult;
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
    if (argv[1] === 'view') {
      return (
        fake.view ?? ok({ state: 'OPEN', baseRefName: 'feat/1-the-dependency' })
      );
    }
    if (argv[1] === 'edit') return fake.edit ?? ok();
    return fail('unsupported');
  };
  const run = (a: CardPrRetargetArgs = args) =>
    retargetCardPr(a, { exec, watchedProjects: () => [project] });
  return { gh, run };
};

describe('card.prRetarget (#636)', () => {
  it('moves the open PR onto the base with argument arrays', async () => {
    const t = setup({});
    const result = await t.run();
    expect(result).toEqual({ retargeted: true, alreadyThere: false });
    expect(cardPrRetargetResultSchema.safeParse(result).success).toBe(true);
    expect(t.gh).toEqual([
      [
        'pr',
        'view',
        '42',
        '--repo',
        'acme/widget',
        '--json',
        'state,baseRefName',
      ],
      ['pr', 'edit', '42', '--repo', 'acme/widget', '--base', 'develop'],
    ]);
  });

  it('edits nothing when the PR already goes into the base', async () => {
    const t = setup({ view: ok({ state: 'OPEN', baseRefName: 'develop' }) });
    expect(await t.run()).toEqual({ retargeted: true, alreadyThere: true });
    expect(t.gh).toHaveLength(1);
  });

  it('leaves a merged or closed PR alone', async () => {
    for (const state of ['MERGED', 'CLOSED']) {
      const t = setup({ view: ok({ state, baseRefName: 'feat/1-x' }) });
      expect(await t.run()).toMatchObject({
        retargeted: false,
        error: 'not_open',
      });
      expect(t.gh).toHaveLength(1);
    }
  });

  it('reports a view or edit gh could not do', async () => {
    const viewFails = setup({ view: fail('HTTP 502: Bad Gateway') });
    expect(await viewFails.run()).toEqual({
      retargeted: false,
      error: 'gh_failed',
      message: 'HTTP 502: Bad Gateway',
    });
    expect(viewFails.gh).toHaveLength(1);

    const editFails = setup({ edit: fail('HTTP 403: forbidden') });
    expect(await editFails.run()).toEqual({
      retargeted: false,
      error: 'gh_failed',
      message: 'HTTP 403: forbidden',
    });
    expect(editFails.gh.map((a) => a[1])).toEqual(['view', 'edit']);
  });

  it('takes no base that is not a branch name', () => {
    for (const base of ['--force', 'a..b', '']) {
      expect(
        cardPrRetargetArgsSchema.safeParse({ ...args, base }).success,
      ).toBe(false);
    }
  });
});
