import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CARD_ENV_ID } from '@nautelle/shared';
import type { CardReviewArgs } from '@nautelle/shared/protocol';
import { CommandFailure } from '../commands/failure';
import type { ConfigProfile } from '../config';
import type { Exec } from '../detect/exec';
import { CARD_REVIEW_ENV } from '../mcp/tools';
import { FakeClock } from '../testing/fake-clock';
import { memoryLogger } from '../testing/fixtures';
import { REAL_PROCESS_TIMEOUT_MS } from '../testing/projects';
import { releaseTmuxServer } from '../testing/tmux';
import { CardExecutor } from './executor';
import { cardWorktreePath } from './launch';
import { cardReviewEnvId, cardReviewWorktreePath } from './review';
import { cardsWorkspace } from './testing';

setDefaultTimeout(REAL_PROCESS_TIMEOUT_MS * 2);

/**
 * #884 `card.review` / `card.reviewStop` against real git, a real tmux (a
 * private server, `tmux -L <name>`) and the real `exec-run`. The profile
 * binary records its argv and cwd, then waits.
 */
const tmuxInstalled = Bun.which('tmux') !== null;
const MAIN = join(import.meta.dir, '..', 'main.ts');

let teardown: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of teardown.reverse()) await fn();
  teardown = [];
});

const FAKE_CLAUDE = `#!/bin/sh
run="\${OTEL_RESOURCE_ATTRIBUTES##*agentdock.run=}"
printf '%s\\n' "$@" > "$RECORD_DIR/argv-$run"
pwd >> "$RECORD_DIR/argv-$run"
sleep 60
`;

const SESSION = '3bb1739e-1a1c-4baa-b8b4-a4b1e6700361';
const SESSION_2 = '4cc2849f-2b2d-4cbb-89c5-b5c2f7811472';
const BRANCH = 'card/c12-export-csv';
const SHORT = 'ab12cd34';

const setup = async () => {
  const f = await cardsWorkspace();
  const server = `agentdock-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const tmuxServer = ['-L', server];
  teardown.push(async () => {
    await releaseTmuxServer(tmuxServer);
    f.cleanup();
  });
  const binary = join(f.ws, 'fake-claude');
  await Bun.write(binary, FAKE_CLAUDE);
  chmodSync(binary, 0o755);
  const profiles: ConfigProfile[] = [
    {
      id: 'claude-slow',
      runtime: 'claude',
      binary,
      env: { CLAUDE_CONFIG_DIR: f.profileDir, RECORD_DIR: f.ws },
      args: [],
    },
    { id: 'codex-default', runtime: 'codex', env: {}, args: [] },
  ];
  const exec: Exec = (bin, a, opts) => f.exec(bin, a, opts);
  const cardsDir = join(f.ws, 'state', 'cards');
  const tokens: { sessionId: string; cwd: string }[] = [];
  const executor = new CardExecutor({
    deps: f.deps(exec, {
      clock: new FakeClock(Date.parse('2026-10-23T12:00:00.000Z')),
      profiles: () => profiles,
    }),
    cardsDir,
    selfCommand: [process.execPath, MAIN],
    tmuxServer,
    attachmentSource: { server: 'http://127.0.0.1:1', token: 'test' },
    emit: () => {},
    log: memoryLogger().log,
    sessionToken: (binding) => {
      tokens.push(binding);
      return 'review-token';
    },
  });

  // The PR's head: a commit of the card's branch, on origin only.
  await f.run(f.root, 'checkout', '-q', '-b', BRANCH);
  f.write(f.root, { 'src/app.txt': 'v2\n' });
  const head = await f.commitAll(f.root, 'export csv');
  await f.run(f.root, 'push', '-q', 'origin', BRANCH);
  await f.run(f.root, 'checkout', '-q', 'main');
  await f.run(f.root, 'branch', '-q', '-D', BRANCH);

  const args = (over: Partial<CardReviewArgs> = {}): CardReviewArgs => ({
    cardId: 'card_1',
    projectId: f.project.id,
    runId: 'run_review_1',
    root: f.root,
    shortId: SHORT,
    branch: BRANCH,
    headSha: head,
    session: SESSION,
    prompt: 'Review PR #91; $(touch pwned) -- --model x',
    profileKey: 'claude-slow',
    model: 'sonnet',
    permissionMode: 'acceptEdits',
    ...over,
  });
  const tmux = (...a: string[]) => f.git('tmux', [...tmuxServer, ...a]);
  const alive = async (name: string) =>
    (await tmux('has-session', '-t', `=${name}`))?.code === 0;
  const argvOf = async (runId: string) => {
    const file = join(f.ws, `argv-${runId}`);
    for (let i = 0; i < 400 && !existsSync(file); i++) await Bun.sleep(25);
    return readFileSync(file, 'utf8').trimEnd().split('\n');
  };
  const worktree = cardReviewWorktreePath(f.root, SHORT);
  return {
    f,
    executor,
    args,
    head,
    tmux,
    alive,
    argvOf,
    worktree,
    cardsDir,
    tokens,
  };
};

const failure = async (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) =>
      error instanceof CommandFailure ? error.code : String(error),
  );

describe.skipIf(!tmuxInstalled)('card review sessions (#884)', () => {
  it('starts a new session on the PR head in a detached review worktree', async () => {
    const t = await setup();
    expect(await t.executor.review(t.args())).toEqual({
      phase: 'running',
      tmuxSession: 'nautelle-review-ab12cd34',
    });
    expect(await t.alive('nautelle-review-ab12cd34')).toBe(true);

    const argv = await t.argvOf('run_review_1');
    expect(argv.slice(0, 2)).toEqual(['--session-id', SESSION]);
    expect(argv).not.toContain('--resume');
    expect(argv.slice(-3)).toEqual([
      '--',
      'Review PR #91; $(touch pwned) -- --model x',
      t.worktree,
    ]);
    expect(existsSync(join(t.worktree, 'pwned'))).toBe(false);

    const head = await t.f.run(t.worktree, 'rev-parse', 'HEAD');
    expect(head).toBe(t.head);
    // Detached: no branch is checked out, so the card's own stays free.
    expect(
      (await t.f.git('git', ['-C', t.worktree, 'symbolic-ref', '-q', 'HEAD']))
        ?.code,
    ).not.toBe(0);

    const launch = JSON.parse(
      readFileSync(
        join(t.cardsDir, 'card_1', 'review', 'run_review_1', 'run.json'),
        'utf8',
      ),
    ) as { env: Record<string, string>; cwd: string };
    expect(launch.cwd).toBe(t.worktree);
    expect(launch.env[CARD_REVIEW_ENV]).toBe('1');
    expect(launch.env[CARD_ENV_ID]).toBe(cardReviewEnvId(SHORT));
    expect(t.tokens).toEqual([{ sessionId: SESSION, cwd: t.worktree }]);
    expect(t.executor.reviewSession(SESSION)).toBe(true);
    expect(t.executor.reviewSession(SESSION_2)).toBe(false);
  });

  it('replaces the last review and moves its worktree to the new head, cleaned', async () => {
    const t = await setup();
    await t.executor.review(t.args());
    await t.argvOf('run_review_1');
    writeFileSync(join(t.worktree, 'stray.txt'), 'left by the last review\n');

    // A fix round pushed a new head.
    const clone = join(t.f.ws, 'clone');
    await t.f.run(t.f.ws, 'clone', '-q', t.f.origin, clone);
    await t.f.run(clone, 'checkout', '-q', BRANCH);
    t.f.write(clone, { 'src/app.txt': 'v3\n' });
    const next = await t.f.commitAll(clone, 'fix review');
    await t.f.run(clone, 'push', '-q', 'origin', BRANCH);

    await t.executor.review(
      t.args({ runId: 'run_review_2', session: SESSION_2, headSha: next }),
    );
    const argv = await t.argvOf('run_review_2');
    expect(argv.slice(0, 2)).toEqual(['--session-id', SESSION_2]);
    expect(await t.f.run(t.worktree, 'rev-parse', 'HEAD')).toBe(next);
    expect(existsSync(join(t.worktree, 'stray.txt'))).toBe(false);
    expect(readFileSync(join(t.worktree, 'src/app.txt'), 'utf8')).toBe('v3\n');
    expect(t.executor.reviewSession(SESSION)).toBe(false);
    expect(t.executor.reviewSession(SESSION_2)).toBe(true);
    expect(
      existsSync(join(t.cardsDir, 'card_1', 'review', 'run_review_1')),
    ).toBe(false);
  });

  it('never touches the card’s own worktree or session', async () => {
    const t = await setup();
    const cardWorktree = cardWorktreePath(t.f.root, SHORT);
    await t.f.run(
      t.f.root,
      'worktree',
      'add',
      '-q',
      cardWorktree,
      '-b',
      BRANCH,
      `origin/${BRANCH}`,
    );
    writeFileSync(join(cardWorktree, 'wip.txt'), 'unpushed work\n');
    await t.tmux(
      'new-session',
      '-d',
      '-s',
      'nautelle-card-ab12cd34',
      'sleep 60',
    );

    await t.executor.review(t.args());
    expect(await t.executor.stopReview(t.args())).toEqual({ stopped: true });

    expect(await t.alive('nautelle-card-ab12cd34')).toBe(true);
    expect(readFileSync(join(cardWorktree, 'wip.txt'), 'utf8')).toBe(
      'unpushed work\n',
    );
    expect(
      await t.f.run(cardWorktree, 'rev-parse', '--abbrev-ref', 'HEAD'),
    ).toBe(BRANCH);
  });

  it('stops the session and removes the worktree, idempotently', async () => {
    const t = await setup();
    await t.executor.review(t.args());
    await t.argvOf('run_review_1');
    const stop = {
      cardId: 'card_1',
      projectId: t.f.project.id,
      root: t.f.root,
      shortId: SHORT,
    };
    expect(await t.executor.stopReview(stop)).toEqual({ stopped: true });
    expect(await t.alive('nautelle-review-ab12cd34')).toBe(false);
    expect(existsSync(t.worktree)).toBe(false);
    expect(
      await t.f.run(t.f.root, 'worktree', 'list', '--porcelain'),
    ).not.toContain('review-ab12cd34');
    expect(t.executor.reviewSession(SESSION)).toBe(false);
    expect(await t.executor.stopReview(stop)).toEqual({ stopped: false });
  });

  it('refuses a head origin does not have, and a profile that is not claude', async () => {
    const t = await setup();
    expect(
      await failure(t.executor.review(t.args({ headSha: 'f'.repeat(40) }))),
    ).toBe('not_found');
    expect(await t.alive('nautelle-review-ab12cd34')).toBe(false);
    expect(t.executor.reviewSession(SESSION)).toBe(false);
    expect(
      await failure(t.executor.review(t.args({ profileKey: 'codex-default' }))),
    ).toBe('unsupported_runtime');
  });

  it('refuses a card this runner holds for another project', async () => {
    const t = await setup();
    t.executor.store.save({
      cardId: 'card_1',
      projectId: 'prj_other',
      root: t.f.root,
      repo: 'widget',
      shortId: SHORT,
      worktree: cardWorktreePath(t.f.root, SHORT),
      branch: BRANCH,
      base: 'main',
      tmuxSession: 'nautelle-card-ab12cd34',
      runId: 'run_1',
      phase: 'ended',
      startedAt: '2026-10-23T12:00:00.000Z',
    });
    expect(await failure(t.executor.review(t.args()))).toBe('not_found');
  });
});
