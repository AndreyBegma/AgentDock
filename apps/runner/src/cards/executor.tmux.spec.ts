import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CardRunArgs,
  CardRunPhaseChangedData,
  UnsequencedEvent,
} from '@agentdock/shared/protocol';
import { CommandFailure } from '../commands/failure';
import type { ConfigProfile } from '../config';
import type { Exec } from '../detect/exec';
import { FakeClock } from '../testing/fake-clock';
import { memoryLogger } from '../testing/fixtures';
import { REAL_PROCESS_TIMEOUT_MS } from '../testing/projects';
import { CardExecutor } from './executor';
import { cardsWorkspace } from './testing';

setDefaultTimeout(REAL_PROCESS_TIMEOUT_MS * 2);

/**
 * #242 "Runner" against real git, a real tmux and the real `exec-run`. The
 * tmux server is private (`tmux -L <name>`): the user's own server — where
 * live fleets run — is never listed, let alone touched. The profile binary is
 * a script that records its argv and cwd, then exits or waits.
 */
const tmuxInstalled = Bun.which('tmux') !== null;
const MAIN = join(import.meta.dir, '..', 'main.ts');

let teardown: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of teardown.reverse()) await fn();
  teardown = [];
});

// One argv element per line, then the cwd, in a file named after the round
// (`agentdock.run` of the run env); `sleep` keeps the session open.
const FAKE_CLAUDE = `#!/bin/sh
round="\${OTEL_RESOURCE_ATTRIBUTES##*agentdock.run=}"
printf '%s\\n' "$@" > "$RECORD_DIR/argv-$round"
pwd >> "$RECORD_DIR/argv-$round"
if [ "$FAKE_MODE" = sleep ]; then sleep 60; fi
exit 3
`;

const SESSION_ID = '3bb1739e-1a1c-4baa-b8b4-a4b1e6700361';
const PROMPT = 'Work on card C-12; $(touch pwned) `id` "quoted" -- --model x';

const setup = async () => {
  const f = await cardsWorkspace();
  const server = `agentdock-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const tmuxServer = ['-L', server];
  teardown.push(async () => {
    await f.git('tmux', [...tmuxServer, 'kill-server']);
    f.cleanup();
  });

  const binary = join(f.ws, 'fake-claude');
  await Bun.write(binary, FAKE_CLAUDE);
  chmodSync(binary, 0o755);
  const profile = (id: string, mode: string): ConfigProfile => ({
    id,
    runtime: 'claude',
    binary,
    env: {
      CLAUDE_CONFIG_DIR: f.profileDir,
      RECORD_DIR: f.ws,
      FAKE_MODE: mode,
    },
    args: ['--strict-mcp-config'],
  });
  const profiles: ConfigProfile[] = [
    profile('claude-quick', 'quick'),
    profile('claude-slow', 'sleep'),
    { id: 'codex-default', runtime: 'codex', env: {}, args: [] },
  ];

  const tmuxCalls: string[][] = [];
  const exec: Exec = (bin, args, opts) => {
    if (bin === 'tmux') tmuxCalls.push([...args]);
    return f.exec(bin, args, opts);
  };
  const events: UnsequencedEvent[] = [];
  const cardsDir = join(f.ws, 'state', 'cards');
  const make = () =>
    new CardExecutor({
      deps: f.deps(exec, {
        clock: new FakeClock(Date.parse('2026-10-14T12:00:00.000Z')),
        profiles: () => profiles,
      }),
      cardsDir,
      selfCommand: [process.execPath, MAIN],
      tmuxServer,
      emit: (event) => events.push(event),
      log: memoryLogger().log,
    });
  const executor = make();
  await executor.start();
  teardown.push(async () => executor.stop());

  const args = (overrides: Partial<CardRunArgs> = {}): CardRunArgs => ({
    cardId: 'card_1',
    runId: 'run_1',
    projectId: f.project.id,
    root: f.root,
    base: 'main',
    shortId: 'ab12cd34',
    branch: 'card/c12-export-csv',
    session: { id: SESSION_ID, resume: false },
    prompt: PROMPT,
    profileKey: 'claude-quick',
    model: 'opus',
    permissionMode: 'acceptEdits',
    ...overrides,
  });

  const phases = (runId: string) =>
    events
      .filter((e) => e.type === 'card_run.phase_changed')
      .map((e) => e.data as CardRunPhaseChangedData)
      .filter((d) => d.runId === runId);
  const tmux = async (...a: string[]) => f.git('tmux', [...tmuxServer, ...a]);
  const alive = async (name: string) =>
    (await tmux('has-session', '-t', `=${name}`))?.code === 0;
  /** Polls until the session is gone and its round reported. */
  const untilEnded = async (ex: CardExecutor, runId: string) => {
    for (let i = 0; i < 400; i++) {
      await ex.poll();
      if (phases(runId).some((d) => d.phase === 'ended')) return;
      await Bun.sleep(25);
    }
    throw new Error(`${runId} never ended`);
  };
  /** Waits until the fake binary recorded its argv for this round. */
  const argvOf = async (runId: string) => {
    const file = join(f.ws, `argv-${runId}`);
    for (let i = 0; i < 400 && !existsSync(file); i++) await Bun.sleep(25);
    return readFileSync(file, 'utf8').trimEnd().split('\n');
  };
  return {
    f,
    executor,
    make,
    args,
    events,
    phases,
    tmux,
    tmuxCalls,
    alive,
    untilEnded,
    argvOf,
    cardsDir,
  };
};

const failure = async (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) =>
      error instanceof CommandFailure ? error.code : String(error),
  );

describe.skipIf(!tmuxInstalled)(
  'card worker executor (#242 D5, D6, D9)',
  () => {
    it('creates .wt-<repo>-card-<shortid> and tmux agentdock-card-<shortid>, commits files first, launches argv only, emits ended when tmux exits', async () => {
      const t = await setup();
      const spec = '# C-12 Export as CSV\n\nAcceptance: a CSV.\n';
      const result = await t.executor.run(
        t.args({
          files: [{ path: 'docs/specs/card-12-export-csv.md', content: spec }],
        }),
      );
      expect(result).toEqual({
        phase: 'running',
        tmuxSession: 'agentdock-card-ab12cd34',
      });

      const worktree = join(t.f.ws, '.wt-widget-card-ab12cd34');
      expect(existsSync(worktree)).toBe(true);
      expect(await t.f.run(worktree, 'branch', '--show-current')).toBe(
        'card/c12-export-csv',
      );
      // The spec is the branch's first commit on top of origin/main.
      expect(
        await t.f.run(worktree, 'log', '--format=%s', 'origin/main..HEAD'),
      ).toBe('docs: add docs/specs/card-12-export-csv.md');
      expect(
        readFileSync(
          join(worktree, 'docs/specs/card-12-export-csv.md'),
          'utf8',
        ),
      ).toBe(spec);

      // tmux got an argv (no shell string): `exec-run <roundDir>`.
      const created = t.tmuxCalls.find((c) => c.includes('new-session'));
      expect(created).toContain('agentdock-card-ab12cd34');
      expect(created?.slice(-4)).toEqual([
        process.execPath,
        MAIN,
        'exec-run',
        join(t.cardsDir, 'card_1', 'rounds', 'run_1'),
      ]);

      // The binary received the prompt as one element, metacharacters intact.
      const argv = await t.argvOf('run_1');
      expect(argv).toEqual([
        '--strict-mcp-config',
        '--session-id',
        SESSION_ID,
        '--model',
        'opus',
        '--permission-mode',
        'acceptEdits',
        '--',
        PROMPT,
        worktree,
      ]);
      expect(existsSync(join(worktree, 'pwned'))).toBe(false);

      await t.untilEnded(t.executor, 'run_1');
      expect(t.phases('run_1').map((d) => d.phase)).toEqual([
        'starting',
        'running',
        'ended',
      ]);
      const ended = t.phases('run_1').at(-1);
      expect(ended).toMatchObject({
        cardId: 'card_1',
        projectId: t.f.project.id,
        tmuxSession: 'agentdock-card-ab12cd34',
        worktree,
        exitCode: 3,
      });
      // Reported once.
      await t.executor.poll();
      expect(t.phases('run_1').filter((d) => d.phase === 'ended')).toHaveLength(
        1,
      );
    });

    it('feedback resumes in the same worktree, replacing a live session without reporting it ended (D9); stop reports nothing either', async () => {
      const t = await setup();
      await t.executor.run(t.args({ profileKey: 'claude-slow' }));
      expect(await t.alive('agentdock-card-ab12cd34')).toBe(true);

      // Round 2 while round 1 is still open: the old session is killed first.
      await t.executor.run(
        t.args({
          runId: 'run_2',
          profileKey: 'claude-slow',
          session: { id: SESSION_ID, resume: true },
          prompt: 'Review feedback: rename the column.',
        }),
      );
      const argv = await t.argvOf('run_2');
      expect(argv.slice(1, 3)).toEqual(['--resume', SESSION_ID]);
      expect(argv.at(-1)).toBe(join(t.f.ws, '.wt-widget-card-ab12cd34'));
      await t.executor.poll();
      expect(t.phases('run_1').map((d) => d.phase)).toEqual([
        'starting',
        'running',
      ]);
      expect(t.phases('run_2').map((d) => d.phase)).toEqual([
        'starting',
        'running',
      ]);

      expect(
        await t.executor.stopCard({
          cardId: 'card_1',
          projectId: t.f.project.id,
        }),
      ).toEqual({ stopped: true });
      expect(await t.alive('agentdock-card-ab12cd34')).toBe(false);
      await t.executor.poll();
      expect(t.phases('run_2').map((d) => d.phase)).toEqual([
        'starting',
        'running',
      ]);
      expect(
        await t.executor.stopCard({
          cardId: 'card_1',
          projectId: t.f.project.id,
        }),
      ).toEqual({ stopped: false });
    });

    it('a restarted runner keeps watching a live session and reports its end', async () => {
      const t = await setup();
      await t.executor.run(t.args({ profileKey: 'claude-slow' }));
      t.executor.stop();
      const next = t.make();
      await next.start();
      teardown.push(async () => next.stop());
      expect(next.cardSession(t.f.project.id, t.f.root, 'card_1')).toBe(
        'agentdock-card-ab12cd34',
      );
      await t.tmux('kill-session', '-t', '=agentdock-card-ab12cd34');
      await t.untilEnded(next, 'run_1');
      // Killed from outside: no exit record, so no exit code.
      expect(t.phases('run_1').at(-1)?.exitCode).toBeUndefined();
    });

    it('close removes the worktree; a later Run recreates it from the pushed branch', async () => {
      const t = await setup();
      await t.executor.run(t.args());
      await t.untilEnded(t.executor, 'run_1');
      const worktree = join(t.f.ws, '.wt-widget-card-ab12cd34');
      t.f.write(worktree, { 'src/export.ts': 'export const csv = 1;\n' });
      const collected = await t.executor.collect({
        cardId: 'card_1',
        projectId: t.f.project.id,
        root: t.f.root,
        base: 'main',
        branch: 'card/c12-export-csv',
        number: 12,
        title: 'Export as CSV',
        body: 'Work.\n\nAgentDock-Card: C-12',
      });
      expect(collected).toMatchObject({ ahead: 1, pushed: true, prNumber: 7 });

      expect(
        await t.executor.close({
          cardId: 'card_1',
          projectId: t.f.project.id,
          removeWorktree: true,
        }),
      ).toEqual({ stopped: false, worktreeRemoved: true, branchDeleted: true });
      expect(existsSync(worktree)).toBe(false);
      expect(t.executor.cardSession(t.f.project.id, t.f.root, 'card_1')).toBe(
        null,
      );

      // Reopened from Completed and run again: the pushed work is there.
      await t.executor.run(
        t.args({ runId: 'run_2', session: { id: SESSION_ID, resume: true } }),
      );
      expect(readFileSync(join(worktree, 'src/export.ts'), 'utf8')).toBe(
        'export const csv = 1;\n',
      );
    });

    it('refuses a codex profile, an unwatched root, another project’s card and a file path into .git', async () => {
      const t = await setup();
      expect(
        await failure(t.executor.run(t.args({ profileKey: 'codex-default' }))),
      ).toBe('unsupported_runtime');
      expect(
        await failure(t.executor.run(t.args({ root: join(t.f.ws, 'other') }))),
      ).toBe('path_not_allowed');
      expect(
        await failure(
          t.executor.run(
            t.args({
              files: [{ path: '.git/hooks/post-commit', content: 'x' }],
            }),
          ),
        ),
      ).toBe('path_not_allowed');
      expect(t.phases('run_1').map((d) => d.phase)).toEqual([
        'starting',
        'failed',
      ]);

      await t.executor.run(t.args());
      for (const call of [
        t.executor.stopCard({ cardId: 'card_1', projectId: 'prj_other' }),
        t.executor.close({
          cardId: 'card_1',
          projectId: 'prj_other',
          removeWorktree: true,
        }),
      ]) {
        expect(await failure(call)).toBe('not_found');
      }
      expect(t.executor.cardSession('prj_other', t.f.root, 'card_1')).toBe(
        null,
      );
    });
  },
);
