import { describe, expect, it } from 'bun:test';
import {
  commands,
  isCommandName,
  parseCommand,
  WORKTREE_STATUS_MAX_COMMITS,
  WORKTREE_STATUS_MAX_FILES,
  WORKTREE_STATUS_TIMEOUT_MS,
  worktreeCommands,
  worktreeStatusArgsSchema,
  worktreeStatusResultSchema,
} from '../index';

const args = { projectId: 'prj_a', root: '/srv/acme', slot: 'i42-api' };

const parses = (value: unknown): boolean =>
  worktreeStatusArgsSchema.safeParse(value).success;

const sha = 'a'.repeat(40);
const result = {
  slot: 'i42-api',
  branch: 'feat/42-api',
  head: sha,
  base: 'origin/develop',
  ahead: 3,
  behind: 1,
  changed: 2,
  untracked: 1,
  files: [
    { path: 'src/a.ts', status: 'modified', additions: 4, deletions: 1 },
    { path: 'new.md', status: 'untracked', additions: null, deletions: null },
  ],
  filesTruncated: 0,
  commits: [
    {
      sha,
      subject: 'feat: a',
      author: 'Archi',
      at: '2026-10-14T09:12:00+02:00',
    },
  ],
};

describe('worktree.status', () => {
  it('is in the commands map, with the runner handler, for any member', () => {
    expect(isCommandName('worktree.status')).toBe(true);
    expect(Object.keys(commands)).toContain('worktree.status');
    const definition = worktreeCommands['worktree.status'];
    expect(definition.minRole).toBe('viewer');
    expect(definition.timeoutMs).toBe(WORKTREE_STATUS_TIMEOUT_MS);
  });

  it('takes a slot of a watched root, and an optional base ref', () => {
    expect(parses(args)).toBe(true);
    expect(parses({ ...args, base: 'develop' })).toBe(true);
    expect(parses({ ...args, base: 'release/1.2' })).toBe(true);
    expect(parseCommand('worktree.status', args).ok).toBe(true);
  });

  it.each([
    ['a worktree path', { worktree: '/srv/.wt-acme-i42-api' }],
    ['a path', { path: '/etc' }],
    ['argv', { argv: ['status'] }],
    ['a ref range', { range: 'main..HEAD' }],
  ])('refuses %s', (_name, extra) => {
    expect(parses({ ...args, ...extra })).toBe(false);
  });

  it.each([
    ['a path', '../i42'],
    ['a dot', 'i42.1'],
    ['a flag', '-C'],
    ['upper case', 'I42'],
  ])('refuses a slot with %s', (_name, slot) => {
    expect(parses({ ...args, slot })).toBe(false);
  });

  it.each([
    ['a flag', '--output=/tmp/x'],
    ['a range', 'main..HEAD'],
    ['a revision suffix', 'main^{commit}'],
    ['a space', 'main HEAD'],
  ])('refuses a base that is %s', (_name, base) => {
    expect(parses({ ...args, base })).toBe(false);
  });

  it('refuses a relative root', () => {
    expect(parses({ ...args, root: 'acme' })).toBe(false);
  });

  it('answers a bounded status', () => {
    expect(worktreeStatusResultSchema.safeParse(result).success).toBe(true);
    const nulls = {
      ...result,
      branch: null,
      head: null,
      base: null,
      ahead: null,
      behind: null,
    };
    expect(worktreeStatusResultSchema.safeParse(nulls).success).toBe(true);
    const file = result.files[0];
    expect(
      worktreeStatusResultSchema.safeParse({
        ...result,
        files: Array(WORKTREE_STATUS_MAX_FILES + 1).fill(file),
      }).success,
    ).toBe(false);
    expect(
      worktreeStatusResultSchema.safeParse({
        ...result,
        commits: Array(WORKTREE_STATUS_MAX_COMMITS + 1).fill(result.commits[0]),
      }).success,
    ).toBe(false);
  });
});
