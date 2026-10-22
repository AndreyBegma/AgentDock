import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { chmodSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CARD_PR_DESCRIPTION_FILE,
  cardDraftPullRequest,
  cardPullRequestBody,
} from '@nautelle/shared';
import type { CardCollectArgs } from '@nautelle/shared/protocol';
import { CommandFailure } from '../commands/failure';
import { REAL_PROCESS_TIMEOUT_MS } from '../testing/projects';
import {
  collectCard,
  commitFiles,
  ensureWorktree,
  removeCardWorktree,
  startFollowUpBranch,
} from './git';
import { cardWorktreePath } from './launch';
import { pendingPush, pushCardHead } from './push';
import type { CardRecord } from './record';
import { cardsWorkspace } from './testing';

setDefaultTimeout(REAL_PROCESS_TIMEOUT_MS * 2);

/**
 * #359 D1 (push and draft PR), D3 (collect readies it) and D8 (the follow-up
 * branch, Completed's cleanup) against real git and a bare origin; `gh` is
 * faked (it records `pr create`, `pr edit`, `pr ready` and answers `pr list`
 * with what was created).
 */
let teardown: (() => void)[] = [];
afterEach(() => {
  for (const fn of teardown.reverse()) fn();
  teardown = [];
});

const BRANCH = 'card/c12-export-csv';
const SPEC = 'docs/specs/card-12-export-csv.md';

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
    startedAt: '2026-10-16T12:00:00.000Z',
    specFiles: [SPEC],
    pullRequest: cardDraftPullRequest({
      number: 12,
      title: 'Export the report as CSV',
      issueNumber: null,
    }),
  };
  const deps = { exec: f.exec, tempRoot: f.ws };
  await ensureWorktree(deps, record);
  const collectArgs: CardCollectArgs = {
    cardId: record.cardId,
    projectId: record.projectId,
    root: f.root,
    base: 'main',
    branch: BRANCH,
    number: 12,
    title: 'C-12: Export the report as CSV',
    body: cardPullRequestBody({
      number: 12,
      summary: 'Added the CSV export.',
      issueNumber: null,
    }),
  };
  const originHead = (branch = BRANCH) =>
    f
      .run(f.origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)
      .catch(() => null);
  const head = () => f.run(record.worktree, 'rev-parse', 'HEAD');
  return { f, record, deps, collectArgs, originHead, head };
};

describe('push and draft PR (#359 D1)', () => {
  it('pushes after the worker amended the pushed commit: the old head is merged with -s ours (#630)', async () => {
    const { f, record, deps, originHead, head } = await setup();
    f.write(record.worktree, { 'a.txt': 'a\n' });
    const first = await f.commitAll(record.worktree, 'feat: a');
    await pushCardHead(deps, record);
    expect(await originHead()).toBe(first);
    f.write(record.worktree, { 'a.txt': 'a2\n' });
    await f.run(record.worktree, 'commit', '-q', '-a', '--amend', '--no-edit');
    const amended = await head();

    const step = await pushCardHead(deps, { ...record, pushedHead: first });

    expect(step?.pushed).toBe(true);
    expect(step?.headSha).toBe(await head());
    expect(await originHead()).toBe(await head());
    expect(
      (await f.run(record.worktree, 'log', '-1', '--format=%P', 'HEAD')).split(
        ' ',
      ),
    ).toEqual([amended, first]);
  });

  it('nothing ahead of the base: nothing is pushed or opened', async () => {
    const { f, record, deps, originHead } = await setup();
    expect(await pushCardHead(deps, record)).toBeNull();
    expect(f.gh.calls).toEqual([]);
    expect(await originHead()).toBeNull();
  });

  it('pushes the first commit and opens one draft PR whose body links the spec', async () => {
    const { f, record, deps, originHead, head } = await setup();
    await commitFiles(deps, record.worktree, [
      { path: SPEC, content: '# C-12\n' },
    ]);
    const step = await pushCardHead(deps, record);
    expect(step).toEqual({
      headSha: await head(),
      pushed: true,
      protectedPaths: [],
      ahead: 1,
      pr: {
        number: 7,
        url: 'https://github.com/acme/widget/pull/7',
        state: 'draft',
        opened: true,
      },
    });
    expect(await originHead()).toBe(await head());
    const creates = f.prCreates();
    expect(creates).toHaveLength(1);
    const created = creates[0];
    expect(created?.args).toContain('--draft');
    expect(created?.args.slice(created.args.indexOf('--title'))[1]).toBe(
      'C-12: Export the report as CSV',
    );
    expect(created?.body).toStartWith(
      `Spec: [${SPEC}](https://github.com/acme/widget/blob/card/c12-export-csv/docs/specs/card-12-export-csv.md)`,
    );
    expect(created?.body).toContain('Nautelle-Card: C-12');
  });

  it('pushes only the committed HEAD — never the index or the working tree — and a known head is not pushed again', async () => {
    const { f, record, deps, originHead, head } = await setup();
    f.write(record.worktree, { 'src/a.ts': 'export const a = 1;\n' });
    const committed = await f.commitAll(record.worktree, 'feat: a');
    const step = await pushCardHead(deps, record);
    if (!step?.pr) throw new Error('expected a PR');
    record.pushedHead = step.headSha;
    record.pushPr = { number: step.pr.number, url: step.pr.url, opened: true };

    // Mid-change: one file staged, one untouched.
    f.write(record.worktree, { 'src/b.ts': 'export const b = 2;\n' });
    await f.run(record.worktree, 'add', 'src/b.ts');
    writeFileSync(join(record.worktree, 'src/c.ts'), 'wip\n');
    expect(await pendingPush(deps, record)).toBeNull();
    expect(await pushCardHead(deps, record)).toBeNull();
    expect(await originHead()).toBe(committed);

    // The next commit is pushed; the open PR is found, not opened again.
    await f.run(record.worktree, 'commit', '-q', '-m', 'feat: b');
    const next = await pushCardHead(deps, record);
    expect(next).toMatchObject({
      headSha: await head(),
      pushed: true,
      // #837: the commits on the branch ahead of the base.
      ahead: 2,
      pr: { number: 7, state: 'draft', opened: true },
    });
    expect(await originHead()).toBe(await head());
    expect(f.prCreates()).toHaveLength(1);
    const tree = await f.run(
      f.origin,
      'ls-tree',
      '-r',
      '--name-only',
      `refs/heads/${BRANCH}`,
    );
    expect(tree.split('\n')).not.toContain('src/c.ts');
  });

  it('a round without pullRequest, or a checkout on another branch, pushes nothing', async () => {
    const { f, record, deps, originHead } = await setup();
    f.write(record.worktree, { 'src/a.ts': 'export const a = 1;\n' });
    await f.commitAll(record.worktree, 'feat: a');
    expect(
      await pushCardHead(deps, { ...record, pullRequest: undefined }),
    ).toBeNull();
    await f.run(record.worktree, 'switch', '-q', '-c', 'elsewhere');
    expect(await pushCardHead(deps, record)).toBeNull();
    expect(await originHead()).toBeNull();
    expect(await originHead('elsewhere')).toBeNull();
    expect(f.gh.calls).toEqual([]);
  });

  it('a PR somebody opened for the branch is reported, not opened again, and not ours', async () => {
    const { f, record, deps } = await setup();
    f.open.push({
      number: 31,
      url: 'https://github.com/acme/widget/pull/31',
      head: BRANCH,
      isDraft: false,
    });
    f.write(record.worktree, { 'src/a.ts': 'export const a = 1;\n' });
    await f.commitAll(record.worktree, 'feat: a');
    expect((await pushCardHead(deps, record))?.pr).toEqual({
      number: 31,
      url: 'https://github.com/acme/widget/pull/31',
      state: 'open',
      opened: false,
    });
    expect(f.prCreates()).toHaveLength(0);
  });

  it('a failed PR keeps the pushed head and reports prError; the PR is tried again', async () => {
    const { f, record, deps, originHead, head } = await setup();
    f.write(record.worktree, { 'src/a.ts': 'export const a = 1;\n' });
    await f.commitAll(record.worktree, 'feat: a');
    const failing = {
      ...deps,
      exec: (async (binary, args, options) =>
        binary === 'gh' && args[1] === 'list'
          ? { code: 1, stdout: '', stderr: 'HTTP 502' }
          : f.exec(binary, args, options)) as typeof f.exec,
    };
    const step = await pushCardHead(failing, record);
    expect(step).toMatchObject({ pushed: true, pr: null });
    expect(step?.prError).toContain('gh pr list failed');
    expect(await originHead()).toBe(await head());

    record.pushedHead = step?.headSha;
    expect(await pendingPush(deps, record)).toEqual({
      headSha: await head(),
      push: false,
      ahead: 1,
    });
    const retried = await pushCardHead(deps, record);
    expect(retried).toMatchObject({ pushed: false, pr: { number: 7 } });
  });
});

describe('branch policy and protected paths (C-148)', () => {
  const failureOf = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => e,
    );

  it('refuses to push to the default branch with branch_refused, pushing nothing', async () => {
    const { f, record, deps, originHead } = await setup();
    f.gh.branches.defaultBranch = BRANCH;
    f.write(record.worktree, { 'src/a.ts': 'export const a = 1;\n' });
    await f.commitAll(record.worktree, 'feat: a');
    const error = await failureOf(pushCardHead(deps, record));
    expect(error).toBeInstanceOf(CommandFailure);
    expect((error as CommandFailure).code).toBe('branch_refused');
    expect((error as CommandFailure).message).toContain('default branch');
    expect(await originHead()).toBeNull();
    expect(f.prCreates()).toHaveLength(0);
  });

  it('refuses a branch GitHub reports as protected, and collect refuses it too', async () => {
    const { f, record, deps, collectArgs, originHead } = await setup();
    f.gh.branches.protected = [BRANCH];
    f.write(record.worktree, { 'src/a.ts': 'export const a = 1;\n' });
    await f.commitAll(record.worktree, 'feat: a');
    const pushed = await failureOf(pushCardHead(deps, record));
    expect((pushed as CommandFailure).code).toBe('branch_refused');
    const collected = await failureOf(collectCard(deps, record, collectArgs));
    expect((collected as CommandFailure).code).toBe('branch_refused');
    expect(await originHead()).toBeNull();
    expect(f.gh.guardCalls).toContainEqual([
      'api',
      'repos/acme/widget/branches/card/c12-export-csv',
    ]);
  });

  it('when GitHub cannot say the default branch, nothing is pushed and it is not branch_refused', async () => {
    const { f, record, deps, originHead } = await setup();
    f.gh.branches.defaultBranch = null;
    f.write(record.worktree, { 'src/a.ts': 'export const a = 1;\n' });
    await f.commitAll(record.worktree, 'feat: a');
    const error = await failureOf(pushCardHead(deps, record));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CommandFailure);
    expect(await originHead()).toBeNull();
  });

  it('a push changing .woodpecker/pipeline.yml still pushes and reports it as a protected path', async () => {
    const { f, record, deps, collectArgs, originHead, head } = await setup();
    f.write(record.worktree, {
      '.woodpecker/pipeline.yml': 'steps: []\n',
      'deploy/compose.yml': 'services: {}\n',
      'src/a.ts': 'export const a = 1;\n',
    });
    await f.commitAll(record.worktree, 'feat: a');
    const step = await pushCardHead(deps, record);
    expect(step?.pushed).toBe(true);
    expect(step?.protectedPaths).toEqual([
      '.woodpecker/pipeline.yml',
      'deploy/compose.yml',
    ]);
    expect(await originHead()).toBe(await head());

    const result = await collectCard(deps, record, collectArgs);
    expect(result.protectedPaths).toContain('.woodpecker/pipeline.yml');
  });
});

describe('collect readies the draft (#359 D3)', () => {
  it('the runner’s draft leaves draft; without the worker’s file its placeholder body is replaced by the summary and the spec link', async () => {
    const { f, record, deps, collectArgs } = await setup();
    f.write(record.worktree, { 'src/a.ts': 'export const a = 1;\n' });
    await f.commitAll(record.worktree, 'feat: a');
    const step = await pushCardHead(deps, record);
    if (!step?.pr) throw new Error('expected a PR');
    record.pushPr = { number: 7, url: step.pr.url, opened: true };

    const result = await collectCard(deps, record, collectArgs);
    expect(result).toMatchObject({ prNumber: 7, prState: 'open' });
    expect(f.readies).toEqual([['pr', 'ready', '7', '--repo', 'acme/widget']]);
    expect(f.edits).toHaveLength(1);
    expect(f.edits[0]?.body).toStartWith(`Spec: [${SPEC}]`);
    expect(f.edits[0]?.body).toContain('Added the CSV export.');
    expect(f.edits[0]?.body).not.toContain('Work in progress');
  });

  it('with the worker’s file, its description is the body of the readied PR', async () => {
    const { f, record, deps, collectArgs } = await setup();
    f.write(record.worktree, { 'src/a.ts': 'export const a = 1;\n' });
    await f.commitAll(record.worktree, 'feat: a');
    await pushCardHead(deps, record);
    record.pushPr = {
      number: 7,
      url: 'https://github.com/acme/widget/pull/7',
      opened: true,
    };
    f.write(record.worktree, {
      [CARD_PR_DESCRIPTION_FILE]: '## What changed and why\n\nCSV.\n',
    });
    await collectCard(deps, record, collectArgs);
    expect(f.readies).toHaveLength(1);
    expect(f.edits.at(-1)?.body).toStartWith('## What changed and why');
  });

  it('a draft somebody else opened stays a draft with its body', async () => {
    const { f, record, deps, collectArgs } = await setup();
    f.open.push({
      number: 31,
      url: 'https://github.com/acme/widget/pull/31',
      head: BRANCH,
      isDraft: true,
    });
    f.write(record.worktree, { 'src/a.ts': 'export const a = 1;\n' });
    await f.commitAll(record.worktree, 'feat: a');
    const result = await collectCard(deps, record, collectArgs);
    expect(result).toMatchObject({ prNumber: 31, prState: 'draft' });
    expect(f.readies).toEqual([]);
    expect(f.edits).toEqual([]);
  });
});

describe('follow-up branch and cleanup (#359 D8)', () => {
  /** The card's first PR, merged into main on origin and its branch deleted. */
  const mergeFirst = async (t: Awaited<ReturnType<typeof setup>>) => {
    const { f, record, deps } = t;
    f.write(record.worktree, { 'src/a.ts': 'export const a = 1;\n' });
    await f.commitAll(record.worktree, 'feat: a');
    const step = await pushCardHead(deps, record);
    record.pushedHead = step?.headSha;
    await f.run(f.origin, 'update-ref', 'refs/heads/main', step?.headSha ?? '');
    await f.run(f.origin, 'update-ref', '-d', `refs/heads/${BRANCH}`);
  };

  it('creates card/c<n>-<slug>-2 from the updated origin/<base> in the same worktree', async () => {
    const t = await setup();
    await mergeFirst(t);
    const next = { ...t.record, branch: `${BRANCH}-2` };
    await startFollowUpBranch(t.deps, next);
    expect(await t.f.run(next.worktree, 'branch', '--show-current')).toBe(
      `${BRANCH}-2`,
    );
    expect(await t.head()).toBe(
      await t.f.run(t.f.root, 'rev-parse', 'refs/remotes/origin/main'),
    );
    expect(await t.f.run(next.worktree, 'ls-files', 'src/a.ts')).toBe(
      'src/a.ts',
    );
    // A card.run retried after a timeout finds it done.
    await startFollowUpBranch(t.deps, next);
  });

  it('refuses a branch that exists here or on origin, and a dirty worktree', async () => {
    const t = await setup();
    await mergeFirst(t);
    const code = (p: Promise<unknown>) =>
      p.then(
        () => 'resolved',
        (e: unknown) => (e instanceof CommandFailure ? e.code : String(e)),
      );
    await t.f.run(
      t.f.root,
      'branch',
      `${BRANCH}-2`,
      'refs/remotes/origin/main',
    );
    expect(
      await code(
        startFollowUpBranch(t.deps, { ...t.record, branch: `${BRANCH}-2` }),
      ),
    ).toBe('already_exists');
    await t.f.run(
      t.f.origin,
      'update-ref',
      `refs/heads/${BRANCH}-3`,
      'refs/heads/main',
    );
    expect(
      await code(
        startFollowUpBranch(t.deps, { ...t.record, branch: `${BRANCH}-3` }),
      ),
    ).toBe('already_exists');
    writeFileSync(join(t.record.worktree, 'stray.txt'), 'x\n');
    expect(
      await code(
        startFollowUpBranch(t.deps, { ...t.record, branch: `${BRANCH}-4` }),
      ),
    ).toBe('invalid_args');
  });

  it('Completed removes the worktree and the local branches whose head was pushed, never one with unpushed commits', async () => {
    const t = await setup();
    await mergeFirst(t);
    const next: CardRecord = {
      ...t.record,
      branch: `${BRANCH}-2`,
      pushedHead: undefined,
      previousBranches: [{ branch: BRANCH, pushedHead: t.record.pushedHead }],
    };
    await startFollowUpBranch(t.deps, next);
    t.f.write(next.worktree, { 'src/b.ts': 'export const b = 2;\n' });
    await t.f.commitAll(next.worktree, 'feat: b');
    const step = await pushCardHead(t.deps, next);
    next.pushedHead = step?.headSha;
    // Merged with deleteBranch: origin has neither branch any more.
    await t.f.run(t.f.origin, 'update-ref', '-d', `refs/heads/${BRANCH}-2`);

    expect(await removeCardWorktree(t.deps, next)).toEqual({
      worktreeRemoved: true,
      branchDeleted: true,
    });
    expect(existsSync(next.worktree)).toBe(false);
    const branches = await t.f.run(
      t.f.root,
      'branch',
      '--list',
      '--format=%(refname:short)',
    );
    expect(branches.split('\n')).not.toContain(BRANCH);
    expect(branches.split('\n')).not.toContain(`${BRANCH}-2`);
  });

  it('a branch with a commit the runner never pushed is kept', async () => {
    const t = await setup();
    await mergeFirst(t);
    // A commit after the last push, then the remote branch went.
    t.f.write(t.record.worktree, { 'src/late.ts': 'export const l = 1;\n' });
    await t.f.commitAll(t.record.worktree, 'feat: late');
    expect(await removeCardWorktree(t.deps, t.record)).toEqual({
      worktreeRemoved: true,
      branchDeleted: false,
    });
    expect(
      await t.f.run(t.f.root, 'branch', '--list', '--format=%(refname:short)'),
    ).toContain(BRANCH);
  });
});

describe('commitFiles (C-161)', () => {
  it('writes card files 0600 in new 0700 directories, also over an existing file', async () => {
    const { f, record, deps } = await setup();
    f.write(record.worktree, { 'README.md': 'old\n' });
    chmodSync(join(record.worktree, 'README.md'), 0o644);
    await commitFiles(deps, record.worktree, [
      { path: SPEC, content: '# C-12\n' },
      { path: 'README.md', content: 'new\n' },
    ]);
    const mode = (path: string) =>
      statSync(join(record.worktree, path)).mode & 0o777;
    expect(mode(SPEC)).toBe(0o600);
    expect(mode('README.md')).toBe(0o600);
    expect(mode('docs/specs')).toBe(0o700);
  });
});
