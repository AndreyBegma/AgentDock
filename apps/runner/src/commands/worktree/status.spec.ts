import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { join } from 'node:path';
import type { WatchedProject } from '@nautelle/shared/protocol';
import { REAL_PROCESS_TIMEOUT_MS, workspace } from '../../testing/projects';
import { CommandFailure } from '../failure';
import {
  parseLog,
  parseNameStatus,
  parseNumstat,
  parsePorcelainV2,
  worktreeStatus,
} from './status';

setDefaultTimeout(REAL_PROCESS_TIMEOUT_MS);

describe('worktree.status parsers', () => {
  it('reads branch, head, changed and untracked from porcelain v2', () => {
    const sha = 'b'.repeat(40);
    const out = [
      `# branch.oid ${sha}`,
      '# branch.head feat/42',
      '1 .M N... 100644 100644 100644 aaa bbb src/a.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts',
      'src/old.ts',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts',
      '? notes.md',
      '',
    ].join('\0');
    expect(parsePorcelainV2(out)).toEqual({
      head: sha,
      branch: 'feat/42',
      changed: 3,
      untracked: ['notes.md'],
    });
    expect(
      parsePorcelainV2('# branch.oid (initial)\0# branch.head (detached)\0'),
    ).toEqual({ head: null, branch: null, changed: 0, untracked: [] });
  });

  it('reads name-status and numstat, renames under their new path', () => {
    expect([
      ...parseNameStatus('M\0a.ts\0R087\0old.ts\0new.ts\0D\0gone.ts\0'),
    ]).toEqual([
      ['a.ts', 'modified'],
      ['new.ts', 'renamed'],
      ['gone.ts', 'deleted'],
    ]);
    expect([
      ...parseNumstat('3\t1\ta.ts\x002\t0\t\0old.ts\0new.ts\0-\t-\tlogo.png\0'),
    ]).toEqual([
      ['a.ts', { additions: 3, deletions: 1 }],
      ['new.ts', { additions: 2, deletions: 0 }],
      ['logo.png', { additions: null, deletions: null }],
    ]);
  });

  it('reads commits and skips a malformed record', () => {
    const sha = 'c'.repeat(40);
    const out = `${sha}\u001ffeat: x\u001fArchi\u001f2026-10-14T09:00:00+02:00\u001e\nnope\u001e`;
    expect(parseLog(out)).toEqual([
      {
        sha,
        subject: 'feat: x',
        author: 'Archi',
        at: '2026-10-14T09:00:00+02:00',
      },
    ]);
  });
});

let ws: ReturnType<typeof workspace> | undefined;
afterEach(() => ws?.cleanup());

const commitAll = (cwd: string, message: string) =>
  (ws as NonNullable<typeof ws>).run(
    cwd,
    '-c',
    'user.name=Archi',
    '-c',
    'user.email=a@a',
    'commit',
    '-q',
    '-am',
    message,
  );

/** `acme` on `main` with one file, and `.wt-acme-i42` two commits ahead with local edits. */
const fixture = async () => {
  ws = workspace();
  const root = await ws.repo('acme');
  ws.files({ 'acme/src/a.ts': 'one\ntwo\n', 'acme/README.md': 'readme\n' });
  await ws.run(root, 'add', '.');
  await commitAll(root, 'init');
  const wt = join(ws.ws, '.wt-acme-i42');
  await ws.run(root, 'worktree', 'add', '-q', '-b', 'feat/42-x', wt);
  ws.files({ '.wt-acme-i42/src/a.ts': 'one\ntwo\nthree\n' });
  await commitAll(wt, 'feat: three');
  ws.files({ '.wt-acme-i42/src/b.ts': 'b\n' });
  await ws.run(wt, 'add', 'src/b.ts');
  await commitAll(wt, 'feat: b');
  // Uncommitted: an edit to a tracked file and an untracked one.
  ws.files({
    '.wt-acme-i42/README.md': 'readme\nmore\n',
    '.wt-acme-i42/notes.md': 'n\n',
  });
  // `main` moves on by one commit the slot has not seen.
  ws.files({ 'acme/other.ts': 'o\n' });
  await ws.run(root, 'add', 'other.ts');
  await commitAll(root, 'chore: other');
  const project: WatchedProject = { id: 'prj_1', root } as WatchedProject;
  return {
    root,
    wt,
    deps: { exec: ws.git, watchedProjects: () => [project] },
  };
};

describe('worktree.status on a real repository', () => {
  it('reports branch, ahead/behind, the diff against the base and the last commits', async () => {
    const { root, deps } = await fixture();
    const status = await worktreeStatus(
      { projectId: 'prj_1', root, slot: 'i42', base: 'main' },
      deps,
    );
    expect(status.slot).toBe('i42');
    expect(status.branch).toBe('feat/42-x');
    expect(status.head).toMatch(/^[0-9a-f]{40}$/);
    expect(status.base).toBe('main');
    expect(status.ahead).toBe(2);
    expect(status.behind).toBe(1);
    expect(status.changed).toBe(1);
    expect(status.untracked).toBe(1);
    // Against the merge base: `main`'s own new file is not the slot's change.
    expect(status.files).toEqual([
      { path: 'README.md', status: 'modified', additions: 1, deletions: 0 },
      { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 },
      { path: 'src/b.ts', status: 'added', additions: 1, deletions: 0 },
      {
        path: 'notes.md',
        status: 'untracked',
        additions: null,
        deletions: null,
      },
    ]);
    expect(status.filesTruncated).toBe(0);
    expect(status.commits.map((c) => c.subject)).toEqual([
      'feat: b',
      'feat: three',
      'init',
    ]);
    expect(status.commits[0].author).toBe('Archi');
  });

  it('falls back to the default branch when the base does not resolve', async () => {
    const { root, deps } = await fixture();
    const status = await worktreeStatus(
      { projectId: 'prj_1', root, slot: 'i42', base: 'nope' },
      deps,
    );
    // No origin: the default is the root's current branch.
    expect(status.base).toBe('main');
    expect(status.ahead).toBe(2);
  });

  it('refuses a slot without a worktree of the root, and a root not watched', async () => {
    const { root, deps } = await fixture();
    const refused = async (args: Parameters<typeof worktreeStatus>[0]) => {
      try {
        await worktreeStatus(args, deps);
      } catch (error) {
        return error instanceof CommandFailure ? error.code : 'other';
      }
      return 'ok';
    };
    expect(await refused({ projectId: 'prj_1', root, slot: 'i7' })).toBe(
      'path_not_allowed',
    );
    expect(
      await refused({ projectId: 'prj_1', root: '/srv/other', slot: 'i42' }),
    ).toBe('path_not_allowed');
    expect(await refused({ projectId: 'prj_2', root, slot: 'i42' })).toBe(
      'path_not_allowed',
    );
  });

  it('runs git read-only with fixed argv', async () => {
    const { root, deps } = await fixture();
    const calls: string[][] = [];
    await worktreeStatus(
      { projectId: 'prj_1', root, slot: 'i42', base: 'main' },
      {
        ...deps,
        exec: (binary, args, options) => {
          calls.push([binary, ...args]);
          return deps.exec(binary, args, options);
        },
      },
    );
    const verbs = new Set(calls.map((c) => c[3]));
    for (const verb of verbs) {
      expect([
        'worktree',
        'status',
        'rev-parse',
        'rev-list',
        'merge-base',
        'diff',
        'log',
        'remote',
        'symbolic-ref',
        'branch',
      ]).toContain(verb);
    }
    expect(calls.every((c) => c[0] === 'git')).toBe(true);
  });
});
