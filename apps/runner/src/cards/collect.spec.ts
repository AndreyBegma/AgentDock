import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CARD_PR_DESCRIPTION_FILE,
  cardPullRequestBody,
  isDivergedBranchError,
} from '@nautelle/shared';
import type { CardCollectArgs } from '@nautelle/shared/protocol';
import { CommandFailure } from '../commands/failure';
import type { Exec, ExecOptions } from '../detect/exec';
import { GITHUB_GIT_CONFIG, GitAuth, HARDENED_GIT_CONFIG } from '../git-auth';
import { REAL_PROCESS_TIMEOUT_MS } from '../testing/projects';
import {
  collectBranch,
  collectCard,
  ensureWorktree,
  fallbackPullRequestBody,
  isSecretPath,
  pullRequestBodyOf,
  readPullRequestDescription,
  removeCardWorktree,
} from './git';
import { cardWorktreePath } from './launch';
import type { CardRecord } from './record';
import { cardsWorkspace } from './testing';

setDefaultTimeout(REAL_PROCESS_TIMEOUT_MS * 2);

/**
 * D8 and D10 against real git and a bare origin; `gh` is faked (it records
 * `pr create` and answers `pr list` with what was created).
 */
let teardown: (() => void)[] = [];
afterEach(() => {
  for (const fn of teardown.reverse()) fn();
  teardown = [];
});

const BRANCH = 'feat/42-export-csv';

const setup = async () => {
  const f = await cardsWorkspace();
  teardown.push(f.cleanup);
  const record: CardRecord = {
    cardId: 'card_1',
    projectId: f.project.id,
    root: f.root,
    repo: 'widget',
    shortId: 'ab12cd34',
    worktree: cardWorktreePath(f.root, 'ab12cd34'),
    branch: BRANCH,
    base: 'main',
    tmuxSession: 'nautelle-card-ab12cd34',
    runId: 'run_1',
    phase: 'running',
    startedAt: '2026-10-14T12:00:00.000Z',
  };
  const deps = { exec: f.exec, tempRoot: f.ws };
  await ensureWorktree(deps, record);
  const args: CardCollectArgs = {
    cardId: record.cardId,
    projectId: record.projectId,
    root: f.root,
    base: 'main',
    branch: BRANCH,
    number: 12,
    title: 'Export the report as CSV',
    body: cardPullRequestBody({
      number: 12,
      summary: 'Added the CSV export.',
      issueNumber: 42,
    }),
  };
  const originHead = () =>
    f.run(f.origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`);
  return { f, record, deps, args, originHead };
};

describe('card.collect (#242 D8)', () => {
  it('reports "No changes" when nothing is ahead of the base: no push, no PR', async () => {
    const { f, record, deps, args, originHead } = await setup();
    expect(await collectCard(deps, record, args)).toEqual({
      ahead: 0,
      pushed: false,
    });
    expect(f.gh.calls).toEqual([]);
    expect(await originHead().catch(() => null)).toBeNull();
  });

  it('commits leftovers, pushes and opens the PR once with Closes #n and the marker; later only pushes', async () => {
    const { f, record, deps, args, originHead } = await setup();
    // The worker's own commit, and an uncommitted leftover.
    f.write(record.worktree, { 'src/export.ts': 'export const csv = 1;\n' });
    await f.commitAll(record.worktree, 'feat: export as CSV');
    writeFileSync(join(record.worktree, 'notes.md'), 'left over\n');

    const first = await collectCard(deps, record, args);
    expect(first).toEqual({
      ahead: 2,
      pushed: true,
      prNumber: 7,
      prUrl: 'https://github.com/acme/widget/pull/7',
      prState: 'open',
    });
    expect(
      await f.run(record.worktree, 'log', '-1', '--format=%s', 'HEAD'),
    ).toBe('chore: card C-12 work in progress');
    expect(await originHead()).toBe(
      await f.run(record.worktree, 'rev-parse', 'HEAD'),
    );
    const [create] = f.prCreates();
    expect(f.prCreates()).toHaveLength(1);
    expect(create?.args).toEqual(
      expect.arrayContaining([
        '--repo',
        'acme/widget',
        '--base',
        'main',
        '--head',
        BRANCH,
        '--title',
        'Export the report as CSV',
      ]),
    );
    expect(create?.body).toContain('Added the CSV export.');
    expect(create?.body).toContain('Closes #42');
    expect(create?.body).toContain('Nautelle-Card: C-12');
    expect(create?.body?.match(/Nautelle-Card:/g)).toHaveLength(1);

    // Feedback round: more work, collected again — pushed, the PR reused.
    f.write(record.worktree, { 'src/export.ts': 'export const csv = 2;\n' });
    const second = await collectCard(deps, record, args);
    expect(second).toEqual({
      ahead: 3,
      pushed: true,
      prNumber: 7,
      prUrl: 'https://github.com/acme/widget/pull/7',
      prState: 'open',
    });
    expect(f.prCreates()).toHaveLength(1);
    expect(f.listCalls.at(-1)).toEqual(
      expect.arrayContaining(['--head', BRANCH, '--state', 'open']),
    );
    expect(await originHead()).toBe(
      await f.run(record.worktree, 'rev-parse', 'HEAD'),
    );
  });

  it('leaves the project hooks out of its commit', async () => {
    const { f, record, deps, args } = await setup();
    // A pre-commit hook that fails every commit it runs for.
    const hooks = join(f.ws, 'hooks');
    f.write(hooks, { 'pre-commit': '#!/bin/sh\nexit 1\n' });
    chmodSync(join(hooks, 'pre-commit'), 0o755);
    await f.run(f.root, 'config', 'core.hooksPath', hooks);
    f.write(record.worktree, { 'probe.md': 'x\n' });
    await f.run(record.worktree, 'add', 'probe.md');
    expect(
      await f
        .run(record.worktree, 'commit', '-q', '-m', 'probe')
        .catch(() => 'refused'),
    ).toBe('refused');
    writeFileSync(join(record.worktree, 'notes.md'), 'left over\n');
    expect((await collectCard(deps, record, args)).pushed).toBe(true);
  });
});

describe('card.collect after the worker rewrote a pushed commit (#630)', () => {
  it('records the superseded remote with merge -s ours and pushes without force', async () => {
    const { f, record, deps, args, originHead } = await setup();
    f.write(record.worktree, { 'src/export.ts': 'export const csv = 1;\n' });
    const pushed = await f.commitAll(record.worktree, 'feat: export as CSV');
    await collectCard(deps, record, args);
    expect(await originHead()).toBe(pushed);
    // C-241: amended locally (one line different), then more commits.
    f.write(record.worktree, { 'src/export.ts': 'export const csv = 2;\n' });
    await f.run(record.worktree, 'commit', '-q', '-a', '--amend', '--no-edit');
    f.write(record.worktree, { 'src/fix.ts': 'export const fix = 1;\n' });
    const local = await f.commitAll(record.worktree, 'fix: the review');
    const tree = await f.run(record.worktree, 'rev-parse', `${local}^{tree}`);

    const result = await collectCard(deps, record, args);

    expect(result.pushed).toBe(true);
    const head = await f.run(record.worktree, 'rev-parse', 'HEAD');
    expect(await originHead()).toBe(head);
    expect(
      (await f.run(record.worktree, 'log', '-1', '--format=%P', 'HEAD')).split(
        ' ',
      ),
    ).toEqual([local, pushed]);
    expect(await f.run(record.worktree, 'rev-parse', 'HEAD^{tree}')).toBe(tree);
  });

  it('merges a remote tip it pushed itself even without a reflog entry (pushedHead)', async () => {
    const { f, record, deps, args, originHead } = await setup();
    f.write(record.worktree, { 'a.txt': 'a\n' });
    const pushed = await f.commitAll(record.worktree, 'feat: a');
    await collectCard(deps, record, args);
    await f.run(record.worktree, 'reset', '-q', '--hard', 'HEAD~1');
    await f.run(record.worktree, 'reflog', 'expire', '--expire=now', '--all');
    f.write(record.worktree, { 'b.txt': 'b\n' });
    await f.commitAll(record.worktree, 'feat: b');

    await collectCard(deps, { ...record, pushedHead: pushed }, args);

    expect(await originHead()).toBe(
      await f.run(record.worktree, 'rev-parse', 'HEAD'),
    );
  });

  it("refuses somebody else's commits on origin: nothing is pushed, the reason names the branch", async () => {
    const { f, record, deps, args, originHead } = await setup();
    f.write(record.worktree, { 'a.txt': 'a\n' });
    await f.commitAll(record.worktree, 'feat: a');
    await collectCard(deps, record, args);
    // Another clone pushes on top of the card's head.
    const other = join(f.ws, 'other');
    await f.run(f.ws, 'clone', '-q', '-b', BRANCH, f.origin, other);
    f.write(other, { 'theirs.txt': 'theirs\n' });
    const theirs = await f.commitAll(other, 'feat: theirs');
    await f.run(other, 'push', '-q', 'origin', BRANCH);
    f.write(record.worktree, { 'b.txt': 'b\n' });
    await f.commitAll(record.worktree, 'feat: b');

    const error = await collectCard(deps, record, args).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(isDivergedBranchError(error.message)).toBe(true);
    expect(error.message).toContain(`origin/${BRANCH} (${theirs.slice(0, 8)})`);
    expect(await originHead()).toBe(theirs);
  });
});

describe('card.collect after card.close removed the worktree (#344)', () => {
  const localHead = (f: {
    run: (cwd: string, ...a: string[]) => Promise<string>;
    root: string;
  }) =>
    f
      .run(f.root, 'rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`)
      .catch(() => null);
  const collectWorktrees = (ws: string) =>
    readdirSync(ws).filter((name) => name.startsWith('nautelle-collect-'));

  it('pushes the kept local branch, opens the PR, then drops the temporary worktree and the pushed branch', async () => {
    const { f, record, deps, args, originHead } = await setup();
    f.write(record.worktree, { 'src/export.ts': 'export const csv = 1;\n' });
    await f.commitAll(record.worktree, 'feat: export as CSV');
    const head = await f.run(record.worktree, 'rev-parse', 'HEAD');
    expect((await removeCardWorktree(deps, record)).branchDeleted).toBe(false);

    expect(await collectBranch(deps, record, args)).toEqual({
      ahead: 1,
      pushed: true,
      prNumber: 7,
      prUrl: 'https://github.com/acme/widget/pull/7',
      prState: 'open',
    });
    expect(await originHead()).toBe(head);
    expect(f.prCreates()).toHaveLength(1);
    expect(await localHead(f)).toBeNull();
    expect(collectWorktrees(f.ws)).toEqual([]);
    expect(
      await f.run(f.root, 'worktree', 'list', '--porcelain'),
    ).not.toContain('nautelle-collect-');
  });

  it('opens the PR of a branch that is only on origin, leaving no local branch', async () => {
    const { f, record, deps, args, originHead } = await setup();
    f.write(record.worktree, { 'src/export.ts': 'export const csv = 1;\n' });
    await f.commitAll(record.worktree, 'feat: export as CSV');
    await f.run(
      record.worktree,
      'push',
      '-q',
      'origin',
      `HEAD:refs/heads/${BRANCH}`,
    );
    expect((await removeCardWorktree(deps, record)).branchDeleted).toBe(true);

    expect(await collectBranch(deps, record, args)).toMatchObject({
      ahead: 1,
      pushed: true,
      prNumber: 7,
    });
    expect(f.prCreates()).toHaveLength(1);
    expect(await originHead()).not.toBeNull();
    expect(await localHead(f)).toBeNull();
    expect(collectWorktrees(f.ws)).toEqual([]);
  });

  it('answers not_found, naming the branch and no ids, when the branch is nowhere', async () => {
    const { f, record, deps, args } = await setup();
    await removeCardWorktree(deps, record);
    await f.run(f.root, 'branch', '-q', '-D', BRANCH);

    const error = await collectBranch(deps, record, args).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CommandFailure);
    expect((error as CommandFailure).code).toBe('not_found');
    expect((error as CommandFailure).message).toBe(
      `branch ${BRANCH} is neither on the runner nor on origin`,
    );
    expect(f.gh.calls).toEqual([]);
    expect(collectWorktrees(f.ws)).toEqual([]);
  });
});

describe('card.collect reports the open PR (#329 D3, D6)', () => {
  it('fills a lost link: a PR already open is reported, none is opened', async () => {
    const { f, record, deps, args } = await setup();
    f.open.push({
      number: 41,
      url: 'https://github.com/acme/widget/pull/41',
      head: BRANCH,
    });
    writeFileSync(join(record.worktree, 'notes.md'), 'work\n');
    expect(await collectCard(deps, record, args)).toEqual({
      ahead: 1,
      pushed: true,
      prNumber: 41,
      prUrl: 'https://github.com/acme/widget/pull/41',
      prState: 'open',
    });
    expect(f.prCreates()).toHaveLength(0);
  });

  it('reports a draft PR as draft', async () => {
    const { f, record, deps, args } = await setup();
    f.open.push({
      number: 41,
      url: 'https://github.com/acme/widget/pull/41',
      head: BRANCH,
      isDraft: true,
    });
    writeFileSync(join(record.worktree, 'notes.md'), 'work\n');
    expect((await collectCard(deps, record, args)).prState).toBe('draft');
    expect(f.listCalls.at(-1)).toEqual(
      expect.arrayContaining(['--json', 'number,url,isDraft']),
    );
  });
});

describe('card.collect without an SSH agent (#329 D1)', () => {
  const recorded = (exec: Exec, ghLoggedIn: boolean) => {
    const calls: { binary: string; args: string[]; options?: ExecOptions }[] =
      [];
    const inner: Exec = async (binary, argv, options) => {
      calls.push({ binary, args: [...argv], options });
      if (binary === 'gh' && argv[0] === 'auth') {
        return { code: ghLoggedIn ? 0 : 1, stdout: '', stderr: '' };
      }
      return exec(binary, argv, options);
    };
    return { inner, calls };
  };

  it('runs every git child, the push included, with the gh settings', async () => {
    const { f, record, args } = await setup();
    const { inner, calls } = recorded(f.exec, true);
    const auth = new GitAuth(inner);
    expect(await auth.probe()).toBe('gh');
    writeFileSync(join(record.worktree, 'notes.md'), 'work\n');
    const result = await collectCard(
      { exec: auth.wrap(inner), tempRoot: f.ws },
      record,
      args,
    );
    expect(result.pushed).toBe(true);
    const git = calls.filter((c) => c.binary === 'git');
    const push = git.find((c) => c.args.includes('push'));
    expect(push?.options?.gitConfig).toEqual([
      ...HARDENED_GIT_CONFIG,
      ...GITHUB_GIT_CONFIG,
    ]);
    for (const call of git) {
      expect(call.options?.gitConfig).toEqual([
        ...HARDENED_GIT_CONFIG,
        ...GITHUB_GIT_CONFIG,
      ]);
    }
    // gh itself is never given git settings.
    for (const call of calls.filter((c) => c.binary === 'gh')) {
      expect(call.options?.gitConfig).toBeUndefined();
    }
  });

  it('sets nothing when gh is not authenticated', async () => {
    const { f, record, args } = await setup();
    const { inner, calls } = recorded(f.exec, false);
    const auth = new GitAuth(inner);
    expect(await auth.probe()).toBe('native');
    writeFileSync(join(record.worktree, 'notes.md'), 'work\n');
    await collectCard({ exec: auth.wrap(inner), tempRoot: f.ws }, record, args);
    for (const call of calls.filter((c) => c.binary === 'git')) {
      expect(call.options?.gitConfig).toEqual(HARDENED_GIT_CONFIG);
    }
  });
});

describe('card.close worktree removal (#242 D10)', () => {
  it('removes the worktree and deletes the branch once it is pushed', async () => {
    const { f, record, deps, args } = await setup();
    writeFileSync(join(record.worktree, 'notes.md'), 'work\n');
    await collectCard(deps, record, args);
    expect(await removeCardWorktree(deps, record)).toEqual({
      worktreeRemoved: true,
      branchDeleted: true,
    });
    expect(
      await f
        .run(f.root, 'rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`)
        .catch(() => null),
    ).toBeNull();
  });

  it('keeps a branch with unpushed commits', async () => {
    const { f, record, deps, args } = await setup();
    writeFileSync(join(record.worktree, 'notes.md'), 'work\n');
    await collectCard(deps, record, args);
    f.write(record.worktree, { 'more.md': 'not pushed\n' });
    await f.commitAll(record.worktree, 'feat: more');
    const local = await f.run(record.worktree, 'rev-parse', 'HEAD');
    expect(await removeCardWorktree(deps, record)).toEqual({
      worktreeRemoved: true,
      branchDeleted: false,
    });
    expect(await f.run(f.root, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(
      local,
    );
  });

  it('keeps a branch that was never pushed', async () => {
    const { f, record, deps } = await setup();
    f.write(record.worktree, { 'wip.md': 'wip\n' });
    await f.commitAll(record.worktree, 'wip');
    expect(await removeCardWorktree(deps, record)).toEqual({
      worktreeRemoved: true,
      branchDeleted: false,
    });
  });
});

describe('card.collect — the PR description (#359 D3)', () => {
  const DESCRIPTION = [
    'Spec: https://github.com/acme/widget/blob/feat/42-export-csv/docs/specs/42-export-csv.md',
    'Closes #42',
    '',
    '## What changed and why',
    '- **export** — the report as CSV.',
    '',
    '## Acceptance criteria',
    '- [x] CSV download — unit test.',
    'Nautelle-Card: C-99',
  ].join('\n');

  const work = async (
    f: Awaited<ReturnType<typeof setup>>['f'],
    wt: string,
  ) => {
    f.write(wt, { 'src/export.ts': 'export const csv = 1;\n' });
    await f.commitAll(wt, 'feat: export as CSV');
  };

  it("opens the PR with the worker's file as its body, the API's marker its only one, the file never committed", async () => {
    const { f, record, deps, args } = await setup();
    await work(f, record.worktree);
    f.write(record.worktree, { [CARD_PR_DESCRIPTION_FILE]: DESCRIPTION });

    expect((await collectCard(deps, record, args)).pushed).toBe(true);
    const body = f.prCreates()[0]?.body ?? '';
    expect(body).toContain('## What changed and why');
    expect(body).toContain('- [x] CSV download — unit test.');
    expect(body).not.toContain('Added the CSV export.');
    expect(body.match(/Nautelle-Card:/g)).toHaveLength(1);
    expect(body.trimEnd().endsWith('Nautelle-Card: C-12')).toBe(true);
    expect(
      await f.run(record.worktree, 'ls-tree', '-r', '--name-only', 'HEAD'),
    ).not.toContain('.agentdock');
    expect(f.edits).toEqual([]);
  });

  it('edits the body of a PR already open when the file exists, and only then', async () => {
    const { f, record, deps, args } = await setup();
    await work(f, record.worktree);
    await collectCard(deps, record, args);
    expect(f.prCreates()).toHaveLength(1);

    f.write(record.worktree, { 'src/export.ts': 'export const csv = 2;\n' });
    await collectCard(deps, record, args);
    expect(f.edits).toEqual([]);

    f.write(record.worktree, { [CARD_PR_DESCRIPTION_FILE]: DESCRIPTION });
    await collectCard(deps, record, args);
    expect(f.prCreates()).toHaveLength(1);
    expect(f.edits).toHaveLength(1);
    expect(f.edits[0]?.args.slice(0, 5)).toEqual([
      'pr',
      'edit',
      '7',
      '--repo',
      'acme/widget',
    ]);
    expect(f.edits[0]?.body).toContain('## Acceptance criteria');
    expect(f.edits[0]?.body).toContain('Nautelle-Card: C-12');
    expect(f.edits[0]?.body).not.toContain('C-99');
  });

  it("without the file: the API's body, led by the links to the spec and the design", async () => {
    const { f, record, deps, args } = await setup();
    await work(f, record.worktree);
    await collectCard(
      deps,
      {
        ...record,
        specFiles: [
          'docs/specs/42-export-csv.md',
          'docs/specs/42-export-csv/design/1.html',
        ],
      },
      args,
    );
    const blob = 'https://github.com/acme/widget/blob/feat/42-export-csv';
    expect(f.prCreates()[0]?.body).toBe(
      `Spec: [docs/specs/42-export-csv.md](${blob}/docs/specs/42-export-csv.md) · approved design: [docs/specs/42-export-csv/design/1.html](${blob}/docs/specs/42-export-csv/design/1.html)\n\n${args.body}`,
    );
  });

  it('without the file: links every frame of the design (#441)', async () => {
    const { f, record, deps, args } = await setup();
    await work(f, record.worktree);
    await collectCard(
      deps,
      {
        ...record,
        specFiles: [
          'docs/specs/42-export-csv.md',
          'docs/specs/42-export-csv/design/1/page.html',
          'docs/specs/42-export-csv/design/1/tile.html',
        ],
      },
      args,
    );
    const blob = 'https://github.com/acme/widget/blob/feat/42-export-csv';
    expect(f.prCreates()[0]?.body).toContain(
      `approved design: [docs/specs/42-export-csv/design/1/page.html](${blob}/docs/specs/42-export-csv/design/1/page.html), [docs/specs/42-export-csv/design/1/tile.html](${blob}/docs/specs/42-export-csv/design/1/tile.html)`,
    );
  });

  it("without the file or spec files: the API's body as it is", async () => {
    const { f, record, deps, args } = await setup();
    await work(f, record.worktree);
    await collectCard(deps, record, args);
    expect(f.prCreates()[0]?.body).toBe(args.body);
  });

  it('ignores a description reached through a symlink, so no other file reaches the PR', async () => {
    const { f, record, deps, args } = await setup();
    await work(f, record.worktree);
    const secret = join(f.ws, 'secret.txt');
    writeFileSync(secret, 'TOKEN=hunter2\n');
    mkdirSync(join(record.worktree, '.agentdock'), { recursive: true });
    symlinkSync(secret, join(record.worktree, CARD_PR_DESCRIPTION_FILE));
    expect(readPullRequestDescription(record.worktree)).toBeNull();
    await collectCard(deps, record, args);
    expect(f.prCreates()[0]?.body).not.toContain('hunter2');
  });

  it('ignores a .agentdock directory that is a symlink', () => {
    const outside = mkdtempSync(join(tmpdir(), 'agentdock-desc-'));
    const wt = mkdtempSync(join(tmpdir(), 'agentdock-wt-'));
    try {
      writeFileSync(join(outside, 'pull-request.md'), 'leaked\n');
      symlinkSync(outside, join(wt, '.agentdock'));
      expect(readPullRequestDescription(wt)).toBeNull();
      rmSync(join(wt, '.agentdock'));
      mkdirSync(join(wt, '.agentdock'));
      writeFileSync(join(wt, CARD_PR_DESCRIPTION_FILE), '  \n');
      expect(readPullRequestDescription(wt)).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it('trackedOnly stages tracked changes and leaves an untracked .env.local out (C-127)', async () => {
    const { f, record, deps, args } = await setup();
    f.write(record.worktree, { 'src/a.ts': 'one\n' });
    await f.commitAll(record.worktree, 'feat: a');
    f.write(record.worktree, { 'src/a.ts': 'two\n' });
    writeFileSync(join(record.worktree, '.env.local'), 'TOKEN=secret\n');
    const result = await collectCard(deps, record, args, { trackedOnly: true });
    expect(result.staged).toEqual(['src/a.ts']);
    const files = await f.run(
      record.worktree,
      'show',
      '--name-only',
      '--format=',
      'HEAD',
    );
    expect(files.split('\n')).toEqual(['src/a.ts']);
    expect(
      await f.run(record.worktree, 'status', '--porcelain', '--', '.env.local'),
    ).toBe('?? .env.local');
  });

  it('trackedOnly refuses a changed tracked file that matches a secret pattern (C-127)', async () => {
    const { f, record, deps, args } = await setup();
    f.write(record.worktree, { '.env.production': 'A=1\n' });
    await f.commitAll(record.worktree, 'chore: env');
    f.write(record.worktree, { '.env.production': 'A=2\n' });
    const error = await collectCard(deps, record, args, {
      trackedOnly: true,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandFailure);
    expect((error as Error).message).toContain('.env.production');
    expect(
      await f.run(record.worktree, 'diff', '--cached', '--name-only'),
    ).toBe('');
  });

  it('isSecretPath matches the secret patterns only', () => {
    for (const p of ['.env', '.env.local', 'a/b.pem', 'k/id_rsa', 'x.key']) {
      expect(isSecretPath(p)).toBe(true);
    }
    for (const p of ['.env.example', 'src/env.ts', 'README.md']) {
      expect(isSecretPath(p)).toBe(false);
    }
  });

  it('pullRequestBodyOf appends the marker when the API body has one', () => {
    expect(pullRequestBodyOf('Body', 'x\n\nNautelle-Card: C-3')).toBe(
      'Body\n\nNautelle-Card: C-3\n',
    );
    expect(pullRequestBodyOf('Body\nNautelle-Card: C-9', 'no marker')).toBe(
      'Body\n',
    );
  });

  it('fallbackPullRequestBody leaves the body alone without spec files', () => {
    expect(fallbackPullRequestBody('B', 'acme/widget', 'card/c1-x', [])).toBe(
      'B',
    );
  });
});
