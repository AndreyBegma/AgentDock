import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CARD_PUSH_MIN_INTERVAL_MS,
  cardDraftPullRequest,
} from '@agentdock/shared';
import type {
  CardRunArgs,
  CardRunPhaseChangedData,
  CardRunPushedData,
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
  const clock = new FakeClock(Date.parse('2026-10-14T12:00:00.000Z'));
  const make = () =>
    new CardExecutor({
      deps: f.deps(exec, {
        clock,
        profiles: () => profiles,
      }),
      cardsDir,
      selfCommand: [process.execPath, MAIN],
      tmuxServer,
      attachmentSource: { server: 'http://127.0.0.1:1', token: 'test' },
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
    clock,
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
      // #367 D1: the profile has no agentdock plugin — the round's wiring.
      const roundDir = join(t.cardsDir, 'card_1', 'rounds', 'run_1');
      expect(argv).toEqual([
        '--strict-mcp-config',
        '--session-id',
        SESSION_ID,
        '--settings',
        join(roundDir, 'agentdock-settings.json'),
        '--mcp-config',
        join(roundDir, 'agentdock-mcp.json'),
        '--model',
        'opus',
        '--permission-mode',
        'acceptEdits',
        '--',
        PROMPT,
        worktree,
      ]);
      expect(existsSync(join(worktree, 'pwned'))).toBe(false);
      const mcp = JSON.parse(
        readFileSync(join(roundDir, 'agentdock-mcp.json'), 'utf8'),
      );
      expect(mcp.mcpServers.agentdock).toEqual({
        command: process.execPath,
        args: [MAIN, 'mcp'],
      });
      expect(
        t.phases('run_1').find((d) => d.phase === 'running'),
      ).toMatchObject({ wiring: 'injected' });
      expect(
        t.phases('run_1').find((d) => d.phase === 'running')?.wiringReason,
      ).toBeUndefined();
      // #359 D3: `.agentdock/` is excluded without any attachment.
      expect(
        readFileSync(
          await t.f.run(
            worktree,
            'rev-parse',
            '--path-format=absolute',
            '--git-path',
            'info/exclude',
          ),
          'utf8',
        ),
      ).toContain('.agentdock/');

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

    it('#367 D2: a profile that reports the agentdock plugin launches without --settings and --mcp-config', async () => {
      const t = await setup();
      t.f.write(t.f.profileDir, {
        'plugins/installed_plugins.json': JSON.stringify({
          plugins: {
            'agentdock@agentdock': [
              { version: '0.9.2', installPath: '/x', scope: 'user' },
            ],
          },
        }),
      });
      await t.executor.run(t.args());
      const argv = await t.argvOf('run_1');
      expect(argv).not.toContain('--settings');
      expect(argv).not.toContain('--mcp-config');
      expect(
        existsSync(
          join(t.cardsDir, 'card_1', 'rounds', 'run_1', 'agentdock-mcp.json'),
        ),
      ).toBe(false);
      expect(
        t.phases('run_1').find((d) => d.phase === 'running'),
      ).toMatchObject({ wiring: 'plugin' });
    });

    it('#367 D3: a round whose wiring cannot be written still starts, unwired, with the reason', async () => {
      const t = await setup();
      // A directory where the settings file goes: the atomic rename fails.
      mkdirSync(
        join(
          t.cardsDir,
          'card_1',
          'rounds',
          'run_1',
          'agentdock-settings.json',
          'in-the-way',
        ),
        { recursive: true },
      );
      await t.executor.run(t.args());
      const argv = await t.argvOf('run_1');
      expect(argv).not.toContain('--settings');
      expect(argv).not.toContain('--mcp-config');
      expect(
        t.phases('run_1').find((d) => d.phase === 'running'),
      ).toMatchObject({
        wiring: 'none',
        wiringReason: 'settings_write_failed',
      });
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

    it('#359 D1: within one poll of the first commit the branch is pushed with a draft PR, reported as card_run.pushed; later commits wait for the interval', async () => {
      const t = await setup();
      const draft = cardDraftPullRequest({
        number: 12,
        title: 'Export as CSV',
        issueNumber: null,
      });
      await t.executor.run(
        t.args({
          profileKey: 'claude-slow',
          pullRequest: draft,
          files: [
            { path: 'docs/specs/card-12-export-csv.md', content: '# C-12\n' },
          ],
        }),
      );
      const worktree = join(t.f.ws, '.wt-widget-card-ab12cd34');
      const pushed = () =>
        t.events
          .filter((e) => e.type === 'card_run.pushed')
          .map((e) => e.data as CardRunPushedData);

      await t.executor.poll();
      await t.executor.settled();
      const head = await t.f.run(worktree, 'rev-parse', 'HEAD');
      expect(pushed()).toEqual([
        {
          cardId: 'card_1',
          runId: 'run_1',
          projectId: t.f.project.id,
          at: '2026-10-14T12:00:00.000Z',
          branch: 'card/c12-export-csv',
          headSha: head,
          prNumber: 7,
          prUrl: 'https://github.com/acme/widget/pull/7',
          prState: 'draft',
        },
      ]);
      expect(
        await t.f.run(
          t.f.origin,
          'rev-parse',
          'refs/heads/card/c12-export-csv',
        ),
      ).toBe(head);
      expect(t.f.prCreates()).toHaveLength(1);
      expect(t.f.prCreates()[0]?.args).toContain('--draft');

      // A second commit inside the interval waits; after it, one push.
      t.f.write(worktree, { 'src/export.ts': 'export const csv = 1;\n' });
      const second = await t.f.commitAll(worktree, 'feat: export');
      await t.executor.poll();
      await t.executor.settled();
      expect(pushed()).toHaveLength(1);
      t.clock.advance(CARD_PUSH_MIN_INTERVAL_MS);
      await t.executor.poll();
      await t.executor.settled();
      expect(pushed().map((d) => d.headSha)).toEqual([head, second]);
      expect(pushed()[1]).toMatchObject({ prNumber: 7, prState: 'draft' });
      expect(t.f.prCreates()).toHaveLength(1);

      // Nothing new: nothing pushed, nothing reported.
      t.clock.advance(CARD_PUSH_MIN_INTERVAL_MS);
      await t.executor.poll();
      await t.executor.settled();
      expect(pushed()).toHaveLength(2);

      // Collect readies the draft the poll opened (D3).
      const collected = await t.executor.collect({
        cardId: 'card_1',
        projectId: t.f.project.id,
        root: t.f.root,
        base: 'main',
        branch: 'card/c12-export-csv',
        number: 12,
        title: draft.title,
        body: 'Exported.\n\nAgentDock-Card: C-12',
      });
      expect(collected).toMatchObject({ prNumber: 7, prState: 'open' });
      expect(t.f.readies).toHaveLength(1);
    });

    it('#359 D1: a round without pullRequest pushes nothing from the poll', async () => {
      const t = await setup();
      await t.executor.run(
        t.args({
          profileKey: 'claude-slow',
          files: [
            { path: 'docs/specs/card-12-export-csv.md', content: '# C-12\n' },
          ],
        }),
      );
      await t.executor.poll();
      await t.executor.settled();
      expect(t.events.some((e) => e.type === 'card_run.pushed')).toBe(false);
      expect(t.f.gh.calls).toEqual([]);
    });

    it('#359 D8: newBranch resumes the session on a fresh branch from the updated base, opening a second draft PR; Completed removes both branches', async () => {
      const t = await setup();
      const draft = cardDraftPullRequest({
        number: 12,
        title: 'Export as CSV',
        issueNumber: null,
      });
      await t.executor.run(
        t.args({
          profileKey: 'claude-slow',
          pullRequest: draft,
          files: [
            { path: 'docs/specs/card-12-export-csv.md', content: '# C-12\n' },
          ],
        }),
      );
      await t.executor.poll();
      await t.executor.settled();
      const worktree = join(t.f.ws, '.wt-widget-card-ab12cd34');
      const first = await t.f.run(worktree, 'rev-parse', 'HEAD');
      // Auto-merged with deleteBranch on origin.
      await t.f.run(t.f.origin, 'update-ref', 'refs/heads/main', first);
      await t.f.run(
        t.f.origin,
        'update-ref',
        '-d',
        'refs/heads/card/c12-export-csv',
      );
      t.f.open.splice(0);

      await t.executor.run(
        t.args({
          runId: 'run_2',
          profileKey: 'claude-slow',
          branch: 'card/c12-export-csv-2',
          newBranch: true,
          session: { id: SESSION_ID, resume: true },
          prompt: 'Feedback: add a header row.',
          pullRequest: draft,
        }),
      );
      const argv = await t.argvOf('run_2');
      expect(argv.slice(1, 3)).toEqual(['--resume', SESSION_ID]);
      expect(await t.f.run(worktree, 'branch', '--show-current')).toBe(
        'card/c12-export-csv-2',
      );
      expect(await t.f.run(worktree, 'rev-parse', 'HEAD')).toBe(first);

      t.f.write(worktree, { 'src/header.ts': 'export const h = 1;\n' });
      const second = await t.f.commitAll(worktree, 'feat: header row');
      t.clock.advance(CARD_PUSH_MIN_INTERVAL_MS);
      await t.executor.poll();
      await t.executor.settled();
      const pushed = t.events
        .filter((e) => e.type === 'card_run.pushed')
        .map((e) => e.data as CardRunPushedData);
      expect(pushed.at(-1)).toMatchObject({
        runId: 'run_2',
        branch: 'card/c12-export-csv-2',
        headSha: second,
        prState: 'draft',
      });
      const creates = t.f.prCreates();
      expect(creates).toHaveLength(2);
      expect(creates[1]?.args).toContain('card/c12-export-csv-2');

      await t.f.run(
        t.f.origin,
        'update-ref',
        '-d',
        'refs/heads/card/c12-export-csv-2',
      );
      expect(
        await t.executor.close({
          cardId: 'card_1',
          projectId: t.f.project.id,
          removeWorktree: true,
        }),
      ).toEqual({ stopped: true, worktreeRemoved: true, branchDeleted: true });
      const branches = await t.f.run(
        t.f.root,
        'branch',
        '--list',
        '--format=%(refname:short)',
      );
      expect(branches).not.toContain('card/c12-export-csv');
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
