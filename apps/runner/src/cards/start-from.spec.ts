import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { REAL_PROCESS_TIMEOUT_MS } from '../testing/projects';
import { ensureWorktree } from './git';
import { cardWorktreePath } from './launch';
import { cardsWorkspace } from './testing';

setDefaultTimeout(REAL_PROCESS_TIMEOUT_MS * 2);

/**
 * #640 (ADR-0063): round 1 of a card that depends on an unmerged card
 * branches from that card's branch on origin; without `startFrom` it
 * branches from the base, as before.
 */
let teardown: (() => void)[] = [];
afterEach(() => {
  for (const fn of teardown.reverse()) fn();
  teardown = [];
});

const DEPENDENCY = 'feat/c13-export-api';
const BRANCH = 'feat/c14-export-button';

const setup = async () => {
  const f = await cardsWorkspace();
  teardown.push(f.cleanup);
  // The dependency's branch, pushed and not merged into main.
  await f.run(f.root, 'checkout', '-q', '-b', DEPENDENCY);
  f.write(f.root, { 'src/export.txt': 'api\n' });
  const dependencyHead = await f.commitAll(f.root, 'C-13: export api');
  await f.run(f.root, 'push', '-q', 'origin', DEPENDENCY);
  await f.run(f.root, 'checkout', '-q', 'main');
  await f.run(f.root, 'branch', '-q', '-D', DEPENDENCY);
  await f.run(f.root, 'update-ref', '-d', `refs/remotes/origin/${DEPENDENCY}`);
  const record = {
    root: f.root,
    worktree: cardWorktreePath(f.root, 'ab12cd34'),
    branch: BRANCH,
    base: 'main',
  };
  const deps = { exec: f.exec, tempRoot: f.ws };
  return { f, record, deps, dependencyHead };
};

describe('ensureWorktree startFrom', () => {
  it("creates the branch from the dependency's branch, fetched from origin", async () => {
    const { f, record, deps, dependencyHead } = await setup();
    expect(await ensureWorktree(deps, record, DEPENDENCY)).toBe('created');
    expect(await f.run(record.worktree, 'rev-parse', 'HEAD')).toBe(
      dependencyHead,
    );
    expect(
      await f.run(record.worktree, 'symbolic-ref', '--short', 'HEAD'),
    ).toBe(BRANCH);
  });

  it('creates the branch from the base without startFrom', async () => {
    const { f, record, deps, dependencyHead } = await setup();
    await ensureWorktree(deps, record);
    const head = await f.run(record.worktree, 'rev-parse', 'HEAD');
    expect(head).toBe(await f.run(f.root, 'rev-parse', 'origin/main'));
    expect(head).not.toBe(dependencyHead);
  });

  it('keeps a branch already on origin, whatever startFrom says', async () => {
    const { f, record, deps } = await setup();
    await f.run(f.root, 'push', '-q', 'origin', `main:refs/heads/${BRANCH}`);
    await ensureWorktree(deps, record, DEPENDENCY);
    expect(await f.run(record.worktree, 'rev-parse', 'HEAD')).toBe(
      await f.run(f.root, 'rev-parse', 'origin/main'),
    );
  });
});
