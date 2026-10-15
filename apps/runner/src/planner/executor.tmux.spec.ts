import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ATTACHMENTS_WORKTREE_DIR,
  type AttachmentRef,
  attachmentFileName,
} from '@agentdock/shared';
import {
  PLAN_TURN_RESULT_MAX_BYTES,
  type PlanTurnArgs,
  type PlanTurnFinishedData,
  planTurnArgsSchema,
  type UnsequencedEvent,
} from '@agentdock/shared/protocol';
import { CommandFailure } from '../commands/failure';
import type { ConfigProfile } from '../config';
import { SkillRunExecutor } from '../skills/run/executor';
import {
  type RunLogOutbound,
  RunLogStreamer,
  runLogSources,
} from '../skills/run/log';
import { skillsWorkspace, withFakeGh } from '../skills/testing';
import { FakeClock } from '../testing/fake-clock';
import { memoryLogger } from '../testing/fixtures';
import { REAL_PROCESS_TIMEOUT_MS } from '../testing/projects';
import { PLAN_IDLE_MS, PlanTurnExecutor } from './executor';
import { SharedRunSlots } from './slots';

setDefaultTimeout(REAL_PROCESS_TIMEOUT_MS * 2);

/**
 * Spec 172's runner criteria against real git, a private tmux server
 * (`tmux -L <name>`, never the user's own) and the real `exec-run`. The
 * profile binary is a fake `claude` that records, per invocation, its argv,
 * its stdin and its cwd, then answers in `stream-json` with the session id it
 * was given — as the CLI's `system/init` line does.
 */
const tmuxInstalled = Bun.which('tmux') !== null;
const MAIN = join(import.meta.dir, '..', 'main.ts');

let teardown: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of teardown.reverse()) await fn();
  teardown = [];
});

const FAKE_CLAUDE = `#!/bin/sh
n=$(ls "$RECORD_DIR" | wc -l | tr -d ' ')
d="$RECORD_DIR/$n"
mkdir -p "$d"
printf '%s\\n' "$@" > "$d/argv"
cat > "$d/stdin"
pwd > "$d/cwd"
ls .agentdock/attachments > "$d/attachments" 2>/dev/null
git rev-parse HEAD > "$d/head"
sid=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--resume" ] && [ -z "$sid" ]; then sid="$a"; fi
  if [ "$prev" = "--session-id" ]; then sid="$a"; fi
  prev="$a"
done
echo "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"session_id\\":\\"$sid\\",\\"model\\":\\"claude-opus-5-5\\"}"
case "$FAKE_MODE" in
  sleep) sleep 60 ;;
  fail) echo 'Error: No conversation found with session ID' >&2; exit 2 ;;
  big) printf '{"type":"result","subtype":"success","is_error":false,"result":"%s"}\\n' "$(head -c 200000 /dev/zero | tr '\\0' a)"; exit 0 ;;
esac
echo '{"type":"result","subtype":"success","is_error":false,"result":"Planned.\\n\`\`\`agentdock-plan\\n{}\\n\`\`\`"}'
`;

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

const setup = async (options: { cap?: number } = {}) => {
  const f = await skillsWorkspace();
  const server = `agentdock-plan-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const tmuxServer = ['-L', server];
  teardown.push(async () => {
    await f.git('tmux', [...tmuxServer, 'kill-server']);
    f.cleanup();
  });

  const binary = join(f.ws, 'fake-claude');
  await Bun.write(binary, FAKE_CLAUDE);
  chmodSync(binary, 0o755);
  const recordDir = join(f.ws, 'calls');
  const profile = (id: string, mode: string): ConfigProfile => ({
    id,
    runtime: 'claude',
    binary,
    env: {
      CLAUDE_CONFIG_DIR: f.profileDir,
      RECORD_DIR: recordDir,
      FAKE_MODE: mode,
    },
    args: ['--strict-mcp-config'],
  });
  const profiles: ConfigProfile[] = [
    profile('claude-work', 'quick'),
    profile('claude-slow', 'sleep'),
    profile('claude-fail', 'fail'),
    profile('claude-big', 'big'),
    { id: 'codex-default', runtime: 'codex', env: {}, args: [] },
  ];
  // The skill a skill run invokes, for the shared-cap case.
  f.write(f.profileDir, {
    'skills/estimate/SKILL.md': '---\nname: estimate\n---\nEstimate.\n',
  });
  await Bun.write(join(recordDir, '.keep'), '');

  const gh = withFakeGh(f.git, f.root);
  const clock = new FakeClock(Date.parse('2026-10-13T12:00:00.000Z'));
  const events: UnsequencedEvent[] = [];
  let next = 0;
  const deps = f.deps(gh.exec, {
    clock,
    profiles: () => profiles,
    shortId: () => `pln${String(next++).padStart(5, '0')}`,
  });
  const downloads: { url: string; authorization: string | null }[] = [];
  const bodies = new Map<string, Uint8Array>();
  const fakeFetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    downloads.push({
      url,
      authorization: new Headers(init?.headers).get('authorization'),
    });
    const body = bodies.get(url.slice(url.lastIndexOf('/') + 1));
    return body
      ? new Response(body, { status: 200 })
      : new Response('nope', { status: 404 });
  }) as typeof fetch;
  const slots = new SharedRunSlots(options.cap ?? 2);
  const log = memoryLogger().log;
  // Timers far apart: the test ticks and cleans up by hand.
  const never = 365 * 24 * 60 * 60_000;
  const executor = new PlanTurnExecutor({
    deps,
    plansDir: join(f.ws, 'state', 'plans'),
    selfCommand: [process.execPath, MAIN],
    tmuxServer,
    slots,
    emit: (event) => events.push(event),
    log,
    attachmentSource: {
      server: 'https://agentdock.example.test',
      token: 'runner-token',
      fetch: fakeFetch,
    },
    tickMs: never,
    cleanupMs: never,
  });
  await executor.start();
  teardown.push(() => executor.stop());

  const args = (overrides: Partial<PlanTurnArgs> = {}): PlanTurnArgs => ({
    planId: 'plan_1',
    turnId: 'turn_1',
    runId: 'run_t1',
    projectId: f.project.id,
    root: f.root,
    base: 'main',
    session: { id: S1, resume: false },
    prompt: '# Instructions\n\nDecompose: $(rm -rf ~) `x`\n',
    profileKey: 'claude-work',
    model: 'opus',
    timeoutSec: 600,
    ...overrides,
  });

  const until = async (turnId: string, phases: string[], planId = 'plan_1') => {
    for (let i = 0; i < 600; i++) {
      const phase =
        executor.turn(planId, turnId)?.phase ?? finished(turnId)?.phase;
      if (phase && phases.includes(phase)) return phase;
      await executor.tick();
      await Bun.sleep(25);
    }
    throw new Error(`${turnId} stayed ${executor.turn(planId, turnId)?.phase}`);
  };
  const finished = (turnId: string) =>
    events.find(
      (e) =>
        e.type === 'plan_turn.finished' &&
        (e.data as PlanTurnFinishedData).turnId === turnId,
    )?.data as PlanTurnFinishedData | undefined;
  const phases = (turnId: string) =>
    events
      .filter(
        (e) =>
          e.type === 'plan_turn.phase_changed' &&
          (e.data as { turnId: string }).turnId === turnId,
      )
      .map((e) => (e.data as { phase: string }).phase);
  /** What the fake `claude` recorded on its `n`-th invocation (0-based). */
  const call = (n: number) => {
    const read = (name: string) =>
      readFileSync(join(recordDir, String(n), name), 'utf8');
    return {
      argv: read('argv').split('\n').filter(Boolean),
      stdin: read('stdin'),
      cwd: read('cwd').trim(),
      head: read('head').trim(),
      attachments: read('attachments').split('\n').filter(Boolean),
    };
  };
  const calls = () =>
    readdirSync(recordDir).filter((name) => name !== '.keep').length;
  const sessions = async () =>
    (
      (
        await f.git('tmux', [
          ...tmuxServer,
          'list-sessions',
          '-F',
          '#{session_name}',
        ])
      )?.stdout ?? ''
    )
      .split('\n')
      .filter(Boolean);
  const worktree = join(f.ws, '.wt-widget-plan-pln00000');

  return {
    f,
    gh,
    deps,
    clock,
    events,
    slots,
    log,
    tmuxServer,
    executor,
    args,
    until,
    finished,
    phases,
    call,
    calls,
    sessions,
    worktree,
    downloads,
    bodies,
  };
};

const shaOf = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const refOf = (id: string, name: string, bytes: Uint8Array): AttachmentRef => ({
  id,
  name,
  mime: 'text/plain',
  size: bytes.byteLength,
  sha256: shaOf(bytes),
});

const codeOf = async (work: Promise<unknown>) => {
  const error = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CommandFailure);
  return (error as CommandFailure).code;
};

describe.skipIf(!tmuxInstalled)('plan turns (real tmux, fake claude)', () => {
  it('runs the first turn with --session-id, plan mode, the prompt on stdin, in the plan worktree', async () => {
    const t = await setup();
    const prompt = t.args().prompt;
    expect(await t.executor.run(t.args())).toEqual({ phase: 'running' });
    expect(await t.until('turn_1', ['succeeded', 'failed'])).toBe('succeeded');

    const first = t.call(0);
    expect(first.argv).toEqual([
      '--strict-mcp-config',
      '-p',
      '--session-id',
      S1,
      '--model',
      'opus',
      '--permission-mode',
      'plan',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
    // The prompt reached the CLI on stdin, byte for byte, and is in no argv element.
    expect(first.stdin).toBe(prompt);
    expect(first.argv.some((a) => a.includes('Decompose'))).toBe(false);
    expect(
      readFileSync(
        join(
          t.f.ws,
          'state',
          'plans',
          'plan_1',
          'turns',
          'turn_1',
          'prompt.md',
        ),
        'utf8',
      ),
    ).toBe(prompt);
    // D15: `<parent>/.wt-<repo>-plan-<shortid>`, detached at origin/main.
    expect(first.cwd).toBe(t.worktree);
    expect(first.head).toBe(
      await t.f.run(t.f.root, 'rev-parse', 'origin/main'),
    );

    expect(t.phases('turn_1')).toEqual(['queued', 'running', 'succeeded']);
    expect(t.finished('turn_1')).toMatchObject({
      planId: 'plan_1',
      turnId: 'turn_1',
      runId: 'run_t1',
      projectId: 'prj_widget',
      phase: 'succeeded',
      sessionId: S1,
      exitCode: 0,
      resultText: 'Planned.\n```agentdock-plan\n{}\n```',
      resultTruncated: false,
    });
    const envelope = t.events.find((e) => e.type === 'plan_turn.finished');
    expect(envelope).toMatchObject({
      source: 'runner',
      project: { repo: 'acme/widget', root: t.f.root },
    });
    // The worktree stays for the plan's life: `--resume` needs its directory.
    expect(existsSync(t.worktree)).toBe(true);
    expect(await t.sessions()).toEqual([]);
  });

  it('#337 D10: places the attachments in the plan worktree before the session starts, and drops the unlisted ones on the next turn', async () => {
    const t = await setup();
    const shot = new TextEncoder().encode('png-ish bytes');
    t.bodies.set('att1', shot);
    const ref = refOf('att1', 'shot one.png', shot);

    await t.executor.run(t.args({ attachments: [ref] }));
    expect(await t.until('turn_1', ['succeeded', 'failed'])).toBe('succeeded');

    // The CLI saw the file when it started, under the name card.run uses.
    expect(t.call(0).attachments).toEqual([
      attachmentFileName('att1', 'shot one.png'),
    ]);
    expect(
      readFileSync(
        join(t.worktree, ATTACHMENTS_WORKTREE_DIR, 'att1-shot_one.png'),
        'utf8',
      ),
    ).toBe('png-ish bytes');
    expect(t.downloads).toEqual([
      {
        url: 'https://agentdock.example.test/runner/attachments/att1',
        authorization: 'Bearer runner-token',
      },
    ]);
    // `.agentdock/` never shows in the plan worktree's git status.
    expect((await t.f.run(t.worktree, 'status', '--porcelain')).trim()).toBe(
      '',
    );

    // A turn that lists the same file downloads nothing again; one that lists
    // nothing leaves the directory empty.
    await t.executor.run(
      t.args({
        turnId: 'turn_2',
        runId: 'run_t2',
        session: { id: S1, resume: true },
        attachments: [ref],
      }),
    );
    expect(await t.until('turn_2', ['succeeded', 'failed'])).toBe('succeeded');
    expect(t.downloads).toHaveLength(1);
    await t.executor.run(
      t.args({
        turnId: 'turn_3',
        runId: 'run_t3',
        session: { id: S1, resume: true },
      }),
    );
    expect(await t.until('turn_3', ['succeeded', 'failed'])).toBe('succeeded');
    expect(t.call(2).attachments).toEqual([]);
  });

  it('#337 D10: a file that cannot be had fails the turn before the session starts', async () => {
    const t = await setup();
    const missing = refOf('gone', 'gone.png', new TextEncoder().encode('x'));
    const wrong = new TextEncoder().encode('tampered');
    t.bodies.set('bad', wrong);
    const mismatch = refOf(
      'bad',
      'bad.png',
      new TextEncoder().encode('original'),
    );

    await t.executor.run(t.args({ attachments: [missing] }));
    expect(await t.until('turn_1', ['succeeded', 'failed'])).toBe('failed');
    expect(t.calls()).toBe(0);
    expect(t.finished('turn_1')?.error).toContain('attachment gone');

    await t.executor.run(
      t.args({ turnId: 'turn_2', runId: 'run_t2', attachments: [mismatch] }),
    );
    expect(await t.until('turn_2', ['succeeded', 'failed'])).toBe('failed');
    expect(t.calls()).toBe(0);
    expect(t.finished('turn_2')?.error).toContain('SHA-256');
  });

  it('#337 D10: plan.turn refuses a repeated attachment id', () => {
    const ref = refOf('att1', 'a.png', new TextEncoder().encode('x'));
    const base = {
      planId: 'plan_1',
      turnId: 'turn_1',
      runId: 'run_t1',
      projectId: 'prj_widget',
      root: '/srv/widget',
      base: 'main',
      session: { id: S1, resume: false },
      prompt: 'p',
      profileKey: 'claude-work',
      model: 'opus',
      timeoutSec: 600,
    };
    expect(
      planTurnArgsSchema.safeParse({ ...base, attachments: [ref] }).success,
    ).toBe(true);
    expect(planTurnArgsSchema.safeParse(base).success).toBe(true);
    expect(
      planTurnArgsSchema.safeParse({ ...base, attachments: [ref, ref] })
        .success,
    ).toBe(false);
  });

  it('resumes later turns, fast-forwards the worktree first, and forks a task with its own id', async () => {
    const t = await setup();
    await t.executor.run(t.args());
    expect(await t.until('turn_1', ['succeeded', 'failed'])).toBe('succeeded');

    // origin/main moves between turns.
    t.f.write(t.f.root, { 'src/app.txt': 'v2\n' });
    const moved = await t.f.commitAll(t.f.root, 'v2');
    await t.f.run(t.f.root, 'push', '-q', 'origin', 'main');

    await t.executor.run(
      t.args({
        turnId: 'turn_2',
        runId: 'run_t2',
        session: { id: S1, resume: true },
        prompt: 'second',
      }),
    );
    expect(await t.until('turn_2', ['succeeded', 'failed'])).toBe('succeeded');
    const second = t.call(1);
    expect(second.argv.slice(1, 4)).toEqual(['-p', '--resume', S1]);
    expect(second.argv).not.toContain('--session-id');
    expect(second.argv).toContain('plan');
    expect(second.stdin).toBe('second');
    expect(second.cwd).toBe(t.worktree);
    expect(second.head).toBe(moved);

    await t.executor.run(
      t.args({
        turnId: 'turn_3',
        runId: 'run_t3',
        session: { id: S2, resume: true, forkFrom: S1 },
        prompt: 'grill t2',
      }),
    );
    expect(await t.until('turn_3', ['succeeded', 'failed'])).toBe('succeeded');
    const fork = t.call(2);
    expect(fork.argv.slice(1, 7)).toEqual([
      '-p',
      '--resume',
      S1,
      '--fork-session',
      '--session-id',
      S2,
    ]);
    expect(fork.argv.slice(-6)).toEqual([
      'opus',
      '--permission-mode',
      'plan',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
    expect(fork.stdin).toBe('grill t2');
    expect(fork.cwd).toBe(t.worktree);
    // The new session id is the fork's, as the CLI reported it.
    expect(t.finished('turn_3')?.sessionId).toBe(S2);
  });

  it('refuses a codex profile, an unwatched root, a duplicate turn and a second turn while one runs', async () => {
    const t = await setup();
    expect(
      await codeOf(t.executor.run(t.args({ profileKey: 'codex-default' }))),
    ).toBe('unsupported_runtime');
    expect(
      await codeOf(t.executor.run(t.args({ root: join(t.f.ws, 'elsewhere') }))),
    ).toBe('path_not_allowed');
    expect(
      await codeOf(t.executor.run(t.args({ profileKey: 'no-such-profile' }))),
    ).toBe('unknown_profile');

    await t.executor.run(t.args({ profileKey: 'claude-slow' }));
    expect(
      await codeOf(t.executor.run(t.args({ profileKey: 'claude-slow' }))),
    ).toBe('already_exists');
    expect(
      await codeOf(
        t.executor.run(
          t.args({
            turnId: 'turn_2',
            runId: 'run_t2',
            session: { id: S1, resume: true },
          }),
        ),
      ),
    ).toBe('busy');
    await t.executor.cancel({ planId: 'plan_1', turnId: 'turn_1' });
  });

  it('plan.cancel kills the turn session; a finished or unknown turn is not cancelled', async () => {
    const t = await setup();
    await t.executor.run(t.args({ profileKey: 'claude-slow' }));
    for (let i = 0; i < 200 && t.calls() === 0; i++) await Bun.sleep(25);
    expect(await t.sessions()).toEqual(['agentdock-plan-pln00001']);

    expect(
      await t.executor.cancel({ planId: 'plan_1', turnId: 'turn_1' }),
    ).toEqual({ cancelled: true });
    expect(await t.sessions()).toEqual([]);
    expect(t.finished('turn_1')).toMatchObject({
      phase: 'cancelled',
      sessionId: S1,
    });
    expect(
      await t.executor.cancel({ planId: 'plan_1', turnId: 'turn_1' }),
    ).toEqual({ cancelled: false });
    expect(
      await codeOf(t.executor.cancel({ planId: 'plan_1', turnId: 'nope' })),
    ).toBe('not_found');
    // The slot is free again: a next turn runs at once.
    expect(
      await t.executor.run(
        t.args({
          turnId: 'turn_2',
          runId: 'run_t2',
          session: { id: S1, resume: true },
        }),
      ),
    ).toEqual({ phase: 'running' });
    expect(await t.until('turn_2', ['succeeded', 'failed'])).toBe('succeeded');
  });

  it('fails a turn over its timeout, a turn the CLI refuses, and cuts an oversized result', async () => {
    const t = await setup();
    await t.executor.run(t.args({ profileKey: 'claude-slow', timeoutSec: 60 }));
    for (let i = 0; i < 200 && t.calls() === 0; i++) await Bun.sleep(25);
    t.clock.advance(61_000);
    expect(await t.until('turn_1', ['failed', 'succeeded'])).toBe('failed');
    expect(t.finished('turn_1')?.error).toBe(
      'the turn exceeded its 60 s timeout',
    );
    expect(await t.sessions()).toEqual([]);

    await t.executor.run(
      t.args({
        turnId: 'turn_2',
        runId: 'run_t2',
        session: { id: S1, resume: true },
        profileKey: 'claude-fail',
      }),
    );
    expect(await t.until('turn_2', ['failed', 'succeeded'])).toBe('failed');
    expect(t.finished('turn_2')).toMatchObject({
      exitCode: 2,
      error: 'Error: No conversation found with session ID',
      resultTruncated: false,
    });

    await t.executor.run(
      t.args({
        turnId: 'turn_3',
        runId: 'run_t3',
        session: { id: S1, resume: true },
        profileKey: 'claude-big',
      }),
    );
    expect(await t.until('turn_3', ['failed', 'succeeded'])).toBe('succeeded');
    const big = t.finished('turn_3');
    expect(big?.resultTruncated).toBe(true);
    expect(big?.resultText?.length).toBe(PLAN_TURN_RESULT_MAX_BYTES);
  });

  it('plan.close removes the worktree and the plan state; the idle cleanup does so after 14 days', async () => {
    const t = await setup();
    await t.executor.run(t.args());
    expect(await t.until('turn_1', ['succeeded', 'failed'])).toBe('succeeded');
    expect(existsSync(t.worktree)).toBe(true);
    expect(
      await codeOf(
        t.executor.close({ planId: 'plan_1', projectId: 'prj_other' }),
      ),
    ).toBe('not_found');
    expect(
      await t.executor.close({ planId: 'plan_1', projectId: 'prj_widget' }),
    ).toEqual({ removed: true });
    expect(existsSync(t.worktree)).toBe(false);
    expect(existsSync(join(t.f.ws, 'state', 'plans', 'plan_1'))).toBe(false);
    expect(
      await t.executor.close({ planId: 'plan_1', projectId: 'prj_widget' }),
    ).toEqual({ removed: false });
    // git forgot the worktree too.
    expect(
      await t.f.run(t.f.root, 'worktree', 'list', '--porcelain'),
    ).not.toContain('plan-');

    // A second plan, left idle.
    await t.executor.run(
      t.args({ planId: 'plan_2', turnId: 'turn_9', runId: 'run_t9' }),
    );
    expect(await t.until('turn_9', ['succeeded', 'failed'], 'plan_2')).toBe(
      'succeeded',
    );
    const idleWorktree = join(t.f.ws, '.wt-widget-plan-pln00002');
    expect(existsSync(idleWorktree)).toBe(true);
    t.clock.advance(PLAN_IDLE_MS - 60_000);
    await t.executor.cleanup();
    expect(existsSync(idleWorktree)).toBe(true);
    t.clock.advance(120_000);
    await t.executor.cleanup();
    expect(existsSync(idleWorktree)).toBe(false);
    expect(existsSync(join(t.f.ws, 'state', 'plans', 'plan_2'))).toBe(false);
  });

  it('shares the cap with skill runs: each waits for the other', async () => {
    const t = await setup({ cap: 1 });
    const runs = new SkillRunExecutor({
      deps: t.deps,
      runsDir: join(t.f.ws, 'state', 'runs'),
      selfCommand: [process.execPath, MAIN],
      tmuxServer: t.tmuxServer,
      maxConcurrentRuns: 1,
      slots: t.slots,
      maxTimeoutSec: 21_600,
      emit: () => {},
      log: t.log,
      tickMs: 365 * 24 * 60 * 60_000,
      cleanupMs: 365 * 24 * 60 * 60_000,
    });
    await runs.start();
    teardown.push(() => runs.stop());
    const skillArgs = {
      runId: 'run_s1',
      projectId: t.f.project.id,
      root: t.f.root,
      base: 'main',
      skill: 'estimate',
      args: '',
      profileKey: 'claude-work',
      model: 'opus' as const,
      permissionMode: 'auto' as const,
      output: 'report' as const,
      timeoutSec: 600,
    };

    // A plan turn holds the one slot: the skill run waits.
    expect(await t.executor.run(t.args({ profileKey: 'claude-slow' }))).toEqual(
      { phase: 'running' },
    );
    expect(await runs.run(skillArgs)).toEqual({ phase: 'queued' });
    for (let i = 0; i < 200 && t.calls() === 0; i++) await Bun.sleep(25);
    expect(runs.record('run_s1')?.phase).toBe('queued');
    await t.executor.cancel({ planId: 'plan_1', turnId: 'turn_1' });
    // The freed slot started it.
    expect(runs.record('run_s1')?.phase).not.toBe('queued');

    // Now the skill run holds it: a plan turn waits.
    expect(
      await t.executor.run(
        t.args({
          turnId: 'turn_2',
          runId: 'run_t2',
          session: { id: S1, resume: true },
        }),
      ),
    ).toEqual({ phase: 'queued' });
    for (let i = 0; i < 600; i++) {
      const phase = runs.record('run_s1')?.phase;
      if (phase === 'succeeded' || phase === 'failed') break;
      await runs.tick();
      await Bun.sleep(25);
    }
    expect(runs.record('run_s1')?.phase).toBe('succeeded');
    expect(await t.until('turn_2', ['succeeded', 'failed'])).toBe('succeeded');
  });

  it('tails a turn’s stream for its runId, after the turn left memory too (#183)', async () => {
    const t = await setup();
    await t.executor.run(t.args());
    expect(await t.until('turn_1', ['succeeded', 'failed'])).toBe('succeeded');

    const tail = (executor: PlanTurnExecutor, projectId: string) => {
      const sent: RunLogOutbound[] = [];
      const streamer = new RunLogStreamer({
        runs: runLogSources(executor),
        send: (m) => {
          sent.push(m);
          return true;
        },
        clock: t.clock,
        log: t.log,
      });
      streamer.subscribe({
        type: 'subscribe',
        id: 's1',
        kind: 'run_log',
        projectId,
        runId: 'run_t1',
      });
      return sent;
    };
    const expected: RunLogOutbound[] = [
      {
        type: 'run_log',
        id: 's1',
        frame: {
          type: 'lines',
          backlog: true,
          lastOutputAt: expect.any(String),
          lines: [
            { kind: 'system', text: 'session started · claude-opus-5-5' },
            { kind: 'result', text: expect.stringContaining('Planned.') },
          ],
        },
      },
      {
        type: 'run_log',
        id: 's1',
        frame: { type: 'ended', phase: 'succeeded' },
      },
    ];
    expect(tail(t.executor, t.f.project.id)).toEqual(expected);
    // A fresh executor knows the turn only from its directory.
    const restarted = new PlanTurnExecutor({
      deps: t.deps,
      plansDir: t.executor.store.plansDir,
      selfCommand: [],
      slots: new SharedRunSlots(1),
      emit: () => {},
      log: t.log,
      attachmentSource: {
        server: 'https://agentdock.example.test',
        token: 't',
      },
    });
    expect(tail(restarted, t.f.project.id)).toEqual(expected);
    expect(tail(restarted, 'prj_other')).toEqual([
      { type: 'subscribe.error', id: 's1', code: 'not_found' },
    ]);
  });
});
