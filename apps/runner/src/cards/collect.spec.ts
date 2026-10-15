import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cardPullRequestBody } from '@agentdock/shared';
import type { CardCollectArgs } from '@agentdock/shared/protocol';
import type { Exec, ExecOptions } from '../detect/exec';
import { GITHUB_GIT_CONFIG, GitAuth } from '../git-auth';
import { REAL_PROCESS_TIMEOUT_MS } from '../testing/projects';
import { collectCard, ensureWorktree, removeCardWorktree } from './git';
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
    tmuxSession: 'agentdock-card-ab12cd34',
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
    expect(create?.body).toContain('AgentDock-Card: C-12');
    expect(create?.body?.match(/AgentDock-Card:/g)).toHaveLength(1);

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
    expect(push?.options?.gitConfig).toEqual(GITHUB_GIT_CONFIG);
    for (const call of git) {
      expect(call.options?.gitConfig).toEqual(GITHUB_GIT_CONFIG);
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
    for (const call of calls) {
      expect(call.options?.gitConfig).toBeUndefined();
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
