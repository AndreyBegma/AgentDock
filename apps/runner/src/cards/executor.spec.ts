import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CardCollectArgs } from '@nautelle/shared/protocol';
import { CommandFailure } from '../commands/failure';
import { memoryLogger } from '../testing/fixtures';
import { REAL_PROCESS_TIMEOUT_MS } from '../testing/projects';
import { CardExecutor } from './executor';
import { cardsWorkspace } from './testing';

setDefaultTimeout(REAL_PROCESS_TIMEOUT_MS * 2);

/**
 * #282 D3: `card.collect` with a terminal session's `cwd`, against real git
 * and a bare origin (`gh` faked). The cwd is taken only inside the watched
 * root or one of its worktrees; the session's own branch is pushed.
 */
let teardown: (() => void)[] = [];
afterEach(() => {
  for (const fn of teardown.reverse()) fn();
  teardown = [];
});

const BRANCH = 'fix/12-pairing';

const setup = async () => {
  const f = await cardsWorkspace();
  teardown.push(f.cleanup);
  const executor = new CardExecutor({
    deps: f.deps(f.exec),
    cardsDir: join(f.ws, 'state', 'cards'),
    selfCommand: ['true'],
    attachmentSource: { server: 'http://127.0.0.1:1', token: 'test' },
    emit: () => {},
    log: memoryLogger().log,
  });
  const args = (cwd: string, branch = BRANCH): CardCollectArgs => ({
    cardId: 'card_1',
    projectId: f.project.id,
    root: f.root,
    base: 'main',
    branch,
    cwd,
    number: 12,
    title: 'C-12: Fix the pairing flake',
    body: 'Fixed it.\n\nNautelle-Card: C-12',
  });
  const failure = async (work: Promise<unknown>) => {
    try {
      await work;
    } catch (error) {
      if (error instanceof CommandFailure) return error.code;
      throw error;
    }
    throw new Error('expected a CommandFailure');
  };
  const originHead = (branch = BRANCH) =>
    f
      .run(f.origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)
      .catch(() => null);
  return { f, executor, args, failure, originHead };
};

describe('card.collect in a terminal session cwd (#282 D3)', () => {
  it('collects a cwd inside the root: commits leftovers, pushes the branch, opens the PR', async () => {
    const { f, executor, args, originHead } = await setup();
    await f.run(f.root, 'switch', '-q', '-c', BRANCH);
    f.write(f.root, { 'src/pairing.ts': 'export const fixed = false;\n' });
    await f.commitAll(f.root, 'chore: seed');
    f.write(f.root, { 'src/pairing.ts': 'export const fixed = true;\n' });
    // C-127: an untracked file is not the card's — it stays out of the commit.
    f.write(f.root, { '.env.local': 'TOKEN=secret\n' });

    const result = await executor.collect(args(join(f.root, 'src')));
    expect(result).toEqual({
      staged: ['src/pairing.ts'],
      ahead: 2,
      pushed: true,
      prNumber: 7,
      prUrl: 'https://github.com/acme/widget/pull/7',
      prState: 'open',
    });
    expect(await f.run(f.root, 'log', '-1', '--format=%s', 'HEAD')).toBe(
      'chore: card C-12 work in progress',
    );
    expect(await f.run(f.root, 'ls-files', '.env.local')).toBe('');
    expect(await originHead()).toBe(await f.run(f.root, 'rev-parse', 'HEAD'));
    const [create] = f.prCreates();
    expect(f.prCreates()).toHaveLength(1);
    expect(create?.args).toEqual(
      expect.arrayContaining(['--base', 'main', '--head', BRANCH]),
    );
  });

  it('collects a cwd inside one of the root’s git worktrees', async () => {
    const { f, executor, args, originHead } = await setup();
    const worktree = join(f.ws, '.wt-widget-pairing');
    await f.run(f.root, 'worktree', 'add', '-q', '-b', BRANCH, worktree);
    f.write(worktree, { 'src/pairing.ts': 'export const fixed = true;\n' });
    await f.commitAll(worktree, 'fix: the pairing flake');

    const result = await executor.collect(args(join(worktree, 'src')));
    expect(result).toMatchObject({ ahead: 1, pushed: true, prNumber: 7 });
    expect(await originHead()).toBe(await f.run(worktree, 'rev-parse', 'HEAD'));
    // The root itself is untouched.
    expect(await f.run(f.root, 'branch', '--show-current')).toBe('main');
  });

  it('refuses a cwd outside the project, in another repository, or nested in a clone: path_not_allowed', async () => {
    const { f, executor, args, failure, originHead } = await setup();
    await f.run(f.root, 'switch', '-q', '-c', BRANCH);
    f.write(f.root, { 'src/pairing.ts': 'x\n' });
    const nested = join(f.root, 'vendor', 'lib');
    mkdirSync(nested, { recursive: true });
    await f.run(nested, 'init', '-q', '-b', BRANCH);

    for (const cwd of [
      f.ws,
      f.source,
      nested,
      join(f.root, 'missing'),
      `${f.root}-evil`,
      join(f.root, '..', 'origin'),
    ]) {
      expect(await failure(executor.collect(args(cwd)))).toBe(
        'path_not_allowed',
      );
    }
    expect(f.gh.calls).toEqual([]);
    expect(await originHead()).toBeNull();
    expect(await f.run(f.root, 'status', '--porcelain')).not.toBe('');
  });

  it('refuses a checkout that is not on the branch it was asked for: invalid_args, nothing committed', async () => {
    const { f, executor, args, failure, originHead } = await setup();
    f.write(f.root, { 'src/pairing.ts': 'x\n' });
    const before = await f.run(f.root, 'rev-parse', 'HEAD');

    expect(await failure(executor.collect(args(f.root)))).toBe('invalid_args');
    expect(await f.run(f.root, 'rev-parse', 'HEAD')).toBe(before);
    expect(await originHead()).toBeNull();
    expect(f.gh.calls).toEqual([]);
  });

  it('refuses a root that is not watched before it looks at the cwd', async () => {
    const { f, executor, args, failure } = await setup();
    expect(
      await failure(executor.collect({ ...args(f.ws), root: f.ws, cwd: f.ws })),
    ).toBe('path_not_allowed');
  });
});

describe('card.collect of a card whose worktree card.close removed (#344)', () => {
  it('collects the kept branch instead of answering not_found', async () => {
    const { f, executor, args, originHead } = await setup();
    // What card.close leaves: no card record, no worktree, the unpushed branch.
    const worktree = join(f.ws, '.wt-widget-card-ab12cd34');
    await f.run(f.root, 'worktree', 'add', '-q', '-b', BRANCH, worktree);
    f.write(worktree, { 'src/pairing.ts': 'export const fixed = true;\n' });
    await f.commitAll(worktree, 'fix: the pairing flake');
    const head = await f.run(worktree, 'rev-parse', 'HEAD');
    await f.run(f.root, 'worktree', 'remove', '--force', worktree);
    const { cwd: _cwd, ...fleet } = args(f.root);

    expect(await executor.collect(fleet)).toEqual({
      ahead: 1,
      pushed: true,
      prNumber: 7,
      prUrl: 'https://github.com/acme/widget/pull/7',
      prState: 'open',
    });
    expect(await originHead()).toBe(head);
  });
});
