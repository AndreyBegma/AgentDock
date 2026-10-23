import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { join } from 'node:path';
import { REAL_PROCESS_TIMEOUT_MS } from '../testing/projects';
import { ensureWorktree, takeStartBranch } from './git';
import { cardWorktreePath } from './launch';
import { cardsWorkspace } from './testing';

setDefaultTimeout(REAL_PROCESS_TIMEOUT_MS * 2);

/**
 * #854 D1: a session-gone taken card's Run starts the card's worktree on the
 * branch the session pushed, against real git and a bare origin.
 */
let teardown: (() => void)[] = [];
afterEach(() => {
  for (const fn of teardown.reverse()) fn();
  teardown = [];
});

const OWN = 'card/c12-export-csv';
const TAKEN = 'feat/12-export-csv';

const setup = async () => {
  const f = await cardsWorkspace();
  teardown.push(f.cleanup);
  const deps = { exec: f.exec, tempRoot: f.ws };
  const record = {
    root: f.root,
    worktree: cardWorktreePath(f.root, 'ab12cd34'),
    branch: OWN,
    base: 'main',
  };
  const session = join(f.ws, 'session');
  /** The manual session: its own checkout of `TAKEN`, one commit, pushed. */
  const sessionPushes = async () => {
    await f.run(
      f.root,
      'worktree',
      'add',
      '-q',
      '-b',
      TAKEN,
      session,
      'refs/remotes/origin/main',
    );
    f.write(session, { 'src/csv.txt': 'csv\n' });
    const sha = await f.commitAll(session, 'feat: csv export');
    await f.run(session, 'push', '-q', 'origin', TAKEN);
    return sha;
  };
  /** The session's checkout is gone; its local branch stays unless dropped. */
  const sessionEnds = async (dropBranch: boolean) => {
    await f.run(f.root, 'worktree', 'remove', '--force', session);
    if (dropBranch) await f.run(f.root, 'branch', '-q', '-D', TAKEN);
  };
  const branchOf = () => f.run(record.worktree, 'branch', '--show-current');
  const head = () => f.run(record.worktree, 'rev-parse', 'HEAD');
  return {
    f,
    deps,
    record,
    session,
    sessionPushes,
    sessionEnds,
    branchOf,
    head,
  };
};

describe('takeStartBranch (#854 D1)', () => {
  it('a pushed branch: the worktree is created on it, from origin', async () => {
    const t = await setup();
    const pushed = await t.sessionPushes();
    await t.sessionEnds(true);

    expect(await takeStartBranch(t.deps, t.record, TAKEN)).toBeNull();
    await ensureWorktree(t.deps, { ...t.record, branch: TAKEN });

    expect(await t.branchOf()).toBe(TAKEN);
    expect(await t.head()).toBe(pushed);
  });

  it('not pushed: nothing changes and the round launches as today', async () => {
    const t = await setup();

    expect(await takeStartBranch(t.deps, t.record, TAKEN)).toBe(
      'not_on_origin',
    );
    await ensureWorktree(t.deps, t.record);

    expect(await t.branchOf()).toBe(OWN);
    expect(await t.head()).toBe(
      await t.f.run(t.f.root, 'rev-parse', 'refs/remotes/origin/main'),
    );
  });

  it('a local branch that trails origin is fast-forwarded first', async () => {
    const t = await setup();
    const first = await t.sessionPushes();
    t.f.write(t.session, { 'src/csv.txt': 'csv 2\n' });
    const second = await t.f.commitAll(t.session, 'feat: csv 2');
    await t.f.run(t.session, 'push', '-q', 'origin', TAKEN);
    await t.f.run(t.session, 'reset', '-q', '--hard', first);
    await t.sessionEnds(false);

    expect(await takeStartBranch(t.deps, t.record, TAKEN)).toBeNull();
    await ensureWorktree(t.deps, { ...t.record, branch: TAKEN });

    expect(await t.branchOf()).toBe(TAKEN);
    expect(await t.head()).toBe(second);
  });

  it('a local branch ahead of origin keeps its unpushed commits', async () => {
    const t = await setup();
    await t.sessionPushes();
    t.f.write(t.session, { 'src/csv.txt': 'unpushed\n' });
    const ahead = await t.f.commitAll(t.session, 'feat: unpushed');
    await t.sessionEnds(false);

    expect(await takeStartBranch(t.deps, t.record, TAKEN)).toBeNull();
    await ensureWorktree(t.deps, { ...t.record, branch: TAKEN });

    expect(await t.head()).toBe(ahead);
  });

  it('refuses a branch checked out elsewhere, or diverged from origin', async () => {
    const t = await setup();
    const pushed = await t.sessionPushes();
    expect(await takeStartBranch(t.deps, t.record, TAKEN)).toBe(
      'branch_checked_out',
    );

    await t.f.run(t.session, 'reset', '-q', '--hard', `${pushed}~1`);
    t.f.write(t.session, { 'src/other.txt': 'other\n' });
    await t.f.commitAll(t.session, 'feat: other');
    await t.sessionEnds(false);
    expect(await takeStartBranch(t.deps, t.record, TAKEN)).toBe(
      'branch_diverged',
    );
  });

  it('switches a clean existing card worktree, never a dirty one', async () => {
    const t = await setup();
    const pushed = await t.sessionPushes();
    await t.sessionEnds(true);
    await ensureWorktree(t.deps, t.record);

    t.f.write(t.record.worktree, { 'scratch.txt': 'wip\n' });
    expect(await takeStartBranch(t.deps, t.record, TAKEN)).toBe(
      'worktree_dirty',
    );
    expect(await t.branchOf()).toBe(OWN);

    await t.f.run(t.record.worktree, 'clean', '-q', '-f');
    expect(await takeStartBranch(t.deps, t.record, TAKEN)).toBeNull();
    expect(await t.branchOf()).toBe(TAKEN);
    expect(await t.head()).toBe(pushed);
  });

  it('an unreachable origin is fetch_failed, and nothing changes', async () => {
    const t = await setup();
    await t.f.run(
      t.f.root,
      'remote',
      'set-url',
      'origin',
      join(t.f.ws, 'gone'),
    );

    expect(await takeStartBranch(t.deps, t.record, TAKEN)).toBe('fetch_failed');
  });
});
