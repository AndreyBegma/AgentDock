import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  CARD_DIALOG_WAIT_MS,
  CARD_PUSH_MIN_INTERVAL_MS,
  cardDraftPullRequest,
  STEWARD_ACTED_EVENT,
  STEWARD_OBSERVED_EVENT,
  STEWARD_RESUME_TEXT,
  type StewardRunnerConfig,
} from '@nautelle/shared';
import type {
  CardRunArgs,
  CardRunPhaseChangedData,
  CardRunPushedData,
  UnsequencedEvent,
} from '@nautelle/shared/protocol';
import { CommandFailure } from '../commands/failure';
import type { ConfigProfile } from '../config';
import type { Exec } from '../detect/exec';
import { HandoffService, HandoffStateStore, HandoffWriter } from '../handoff';
import { assistantLine, validNote } from '../handoff/testing';
import { FakeClock } from '../testing/fake-clock';
import { memoryLogger } from '../testing/fixtures';
import { REAL_PROCESS_TIMEOUT_MS } from '../testing/projects';
import { releaseTmuxServer } from '../testing/tmux';
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
if [ "$FAKE_MODE" = dialog ]; then
  printf '╭──────────────────────────────────────────╮\\n│ Teach auto mode about your environment?  │\\n│                                          │\\n│ ❯ 1. Yes                                 │\\n│   2. Not now                             │\\n│   3. Don'"'"'t show again                    │\\n╰──────────────────────────────────────────╯\\n'
  stty raw -echo
  dd bs=1 count=1 2>/dev/null | od -An -tx1 > "$RECORD_DIR/key-$round"
  exit 0
fi
if [ "$FAKE_MODE" = quoted ]; then
  printf '● The dialog reads:\\n  Teach auto mode about your environment?\\n   1. Yes\\n   2. Not now\\n   3. Don'"'"'t show again\\n\\n╭──────────────────────────────╮\\n│ >                            │\\n╰──────────────────────────────╯\\n'
  stty raw -echo
  dd bs=1 count=1 2>/dev/null | od -An -tx1 > "$RECORD_DIR/key-$round"
  exit 0
fi
if [ "$FAKE_MODE" = prompt ]; then
  printf '\\n╭────────────────────────────╮\\n│ >                          │\\n╰────────────────────────────╯\\n'
  IFS= read -r line
  printf '%s' "$line" > "$RECORD_DIR/typed-$round"
  sleep 60
fi
if [ "$FAKE_MODE" = quota ]; then
  printf "  ⎿  You've hit your 5-hour limit · resets in 1 hour\\n\\n╭────────────────────────────╮\\n│ >                          │\\n╰────────────────────────────╯\\n"
  IFS= read -r line
  printf '%s' "$line" > "$RECORD_DIR/typed-$round"
  sleep 60
fi
if [ "$FAKE_MODE" = question ]; then
  printf '\\033[2J\\033[H'; cat "$FIXTURES/ask-user-question.txt"
  IFS= read -r line
  printf '\\033[2J\\033[H'; cat "$FIXTURES/ask-user-question-answered.txt"
  IFS= read -r line
  printf '\\033[2J\\033[H'; cat "$FIXTURES/ask-user-questions-two.txt"
  sleep 60
fi
if [ "$FAKE_MODE" = question-tall ]; then
  draw() { printf '\\033[2J\\033[H'; cat "$FIXTURES/ask-user-question.txt"; }
  trap draw WINCH
  draw
  until IFS= read -r line; do :; done
  trap - WINCH
  printf '\\033[2J\\033[H'; cat "$FIXTURES/ask-user-question-answered.txt"
  sleep 60
fi
if [ "$FAKE_MODE" = trust ]; then
  printf '\\033[2J\\033[H'; cat "$FIXTURES/../../collectors/tmux/__fixtures__/trust.txt"
  sleep 60
fi
if [ "$FAKE_MODE" = permission ]; then
  printf 'Do you want to proceed?\\n 1. Yes\\n 2. No\\n'
  sleep 60
fi
exit 3
`;

const SESSION_ID = '3bb1739e-1a1c-4baa-b8b4-a4b1e6700361';
const PROMPT = 'Work on card C-12; $(touch pwned) `id` "quoted" -- --model x';

const setup = async (
  options: {
    steward?: StewardRunnerConfig;
    handoff?: boolean;
    shipContent?: boolean;
  } = {},
) => {
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
  const profile = (id: string, mode: string): ConfigProfile => ({
    id,
    runtime: 'claude',
    binary,
    env: {
      CLAUDE_CONFIG_DIR: f.profileDir,
      RECORD_DIR: f.ws,
      FAKE_MODE: mode,
      FIXTURES: join(import.meta.dir, '__fixtures__'),
    },
    args: ['--strict-mcp-config'],
  });
  const profiles: ConfigProfile[] = [
    profile('claude-quick', 'quick'),
    profile('claude-slow', 'sleep'),
    profile('claude-dialog', 'dialog'),
    profile('claude-permission', 'permission'),
    profile('claude-trust', 'trust'),
    profile('claude-prompt', 'prompt'),
    profile('claude-quoted', 'quoted'),
    profile('claude-question', 'question'),
    profile('claude-question-tall', 'question-tall'),
    profile('claude-quota', 'quota'),
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
  const deps = f.deps(exec, {
    clock,
    profiles: () => profiles,
    // #447: Steward on for the project when the test asks for it.
    watchedProjects: () => [
      {
        ...f.project,
        ...(options.steward ? { steward: options.steward } : {}),
        ...(options.shipContent ? { shipContent: true } : {}),
      },
    ],
  });
  // #449: Context handoff when the test asks for it.
  let current: CardExecutor | null = null;
  const handoff = options.handoff
    ? new HandoffService({
        deps,
        state: new HandoffStateStore((id) => join(cardsDir, id)),
        record: (id) => current?.store.load(id) ?? null,
        records: () => current?.store.all() ?? [],
        typeAtPrompt: async () => false,
        writer: new HandoffWriter({
          dir: join(f.ws, 'state', 'handoff'),
          env: {},
          clock,
          log: memoryLogger().log,
        }),
        emit: (event) => events.push(event),
        log: memoryLogger().log,
      })
    : undefined;
  const make = () => {
    current = new CardExecutor({
      deps,
      handoff,
      cardsDir,
      selfCommand: [process.execPath, MAIN],
      tmuxServer,
      attachmentSource: { server: 'http://127.0.0.1:1', token: 'test' },
      emit: (event) => events.push(event),
      log: memoryLogger().log,
    });
    return current;
  };
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
  /** Waits until the session's pane shows `text`. */
  const paneShows = async (session: string, text: string) => {
    for (let i = 0; i < 400; i++) {
      const pane = await tmux('capture-pane', '-p', '-t', `=${session}:`);
      if (pane?.stdout.includes(text)) return;
      await Bun.sleep(25);
    }
    throw new Error(`${session} never showed ${text}`);
  };
  return {
    f,
    executor,
    make,
    paneShows,
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
    it('answers the Teach auto mode dialog with Escape within one poll (#435)', async () => {
      const t = await setup();
      await t.executor.run(
        t.args({
          cardId: 'card_d',
          runId: 'run_d',
          profileKey: 'claude-dialog',
        }),
      );
      const keyFile = join(t.f.ws, 'key-run_d');
      const key = () =>
        existsSync(keyFile) ? readFileSync(keyFile, 'utf8') : '';
      for (let i = 0; i < 400 && !key().trim(); i++) {
        await t.executor.poll();
        await Bun.sleep(25);
      }
      expect(readFileSync(keyFile, 'utf8').trim()).toBe('1b');
    });

    it('never answers the dialog text when the agent printed it above its input box (#447 DR-08)', async () => {
      const t = await setup();
      await t.executor.run(
        t.args({
          cardId: 'card_q',
          runId: 'run_q',
          profileKey: 'claude-quoted',
        }),
      );
      await t.paneShows('nautelle-card-ab12cd34', '│ >');
      for (let i = 0; i < 3; i++) await t.executor.poll();
      expect(t.tmuxCalls.some((c) => c.includes('send-keys'))).toBe(false);
      expect(
        await t.executor.dismissDialog(
          'nautelle-card-ab12cd34',
          'teach-auto-mode',
        ),
      ).toBe(false);
      expect(t.tmuxCalls.some((c) => c.includes('send-keys'))).toBe(false);
      // The fake's redirect creates the file at once; no key ever reached it.
      await Bun.sleep(200);
      const keyFile = join(t.f.ws, 'key-run_q');
      expect(
        existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '',
      ).toBe('');
      await t.tmux('kill-session', '-t', '=nautelle-card-ab12cd34');
    });

    it('types continue into a round once, a minute after its limit resets (#741)', async () => {
      const t = await setup();
      await t.executor.run(
        t.args({
          cardId: 'card_l',
          runId: 'run_l',
          profileKey: 'claude-quota',
        }),
      );
      const session = 'nautelle-card-ab12cd34';
      const typedFile = join(t.f.ws, 'typed-run_l');
      await t.paneShows(session, 'hit your 5-hour limit');
      const literal = () =>
        t.tmuxCalls.filter((c) => c.includes('send-keys') && c.includes('-l'));
      await t.executor.poll();
      t.clock.advance(3_600_000 + 60_000 - 1);
      await Bun.sleep(100);
      expect(literal()).toHaveLength(0);

      t.clock.advance(1);
      for (let i = 0; i < 200 && !existsSync(typedFile); i++) {
        await Bun.sleep(25);
      }
      for (let i = 0; i < 3; i++) await t.executor.poll();
      expect(readFileSync(typedFile, 'utf8')).toBe('continue');
      expect(literal()).toHaveLength(1);
      expect(
        t.events.filter((e) => e.type === 'card_run.quota').map((e) => e.data),
      ).toEqual([
        expect.objectContaining({
          cardId: 'card_l',
          limit: 'session',
          resetsAt: '2026-10-14T13:00:00.000Z',
          resumed: false,
        }),
        expect.objectContaining({ cardId: 'card_l', resumed: true }),
      ]);
      await t.tmux('kill-session', '-t', `=${session}`);
    });

    it('reports a question on screen once, and the next question again (#473)', async () => {
      const t = await setup();
      await t.executor.run(
        t.args({
          cardId: 'card_a',
          runId: 'run_a',
          profileKey: 'claude-question',
        }),
      );
      const session = 'nautelle-card-ab12cd34';
      const questions = () =>
        t.events.filter((e) => e.type === 'card_run.question');
      await t.paneShows(session, 'Enter to select');
      for (let i = 0; i < 3; i++) await t.executor.poll();
      expect(questions().map((e) => e.data)).toEqual([
        {
          cardId: 'card_a',
          runId: 'run_a',
          projectId: expect.any(String),
          at: expect.any(String),
        },
      ]);
      // The selector is never answered by the runner.
      expect(t.tmuxCalls.some((c) => c.includes('send-keys'))).toBe(false);

      await t.tmux('send-keys', '-t', `=${session}:`, 'Enter');
      await t.paneShows(session, 'auto mode on');
      for (let i = 0; i < 3; i++) await t.executor.poll();
      expect(questions()).toHaveLength(1);

      await t.tmux('send-keys', '-t', `=${session}:`, 'Enter');
      await t.paneShows(session, 'Tab/Arrow keys');
      for (let i = 0; i < 3; i++) await t.executor.poll();
      expect(questions()).toHaveLength(2);
      await t.tmux('kill-session', '-t', `=${session}:`);
    });

    it('#489: reports the question screen with its options, only with content shipped, and null once answered', async () => {
      for (const shipContent of [false, true]) {
        const t = await setup({ shipContent });
        await t.executor.run(
          t.args({
            cardId: 'card_a',
            runId: 'run_a',
            profileKey: 'claude-question-tall',
          }),
        );
        const session = 'nautelle-card-ab12cd34';
        const screens = () =>
          t.events
            .filter((e) => e.type === 'card_run.pending_question')
            .map((e) => (e.data as { question: unknown }).question);
        await t.paneShows(session, 'Enter to select');
        // The whole selector fits: the fake redraws it on the resize.
        await t.tmux(
          'resize-window',
          '-t',
          `=${session}:`,
          '-x',
          '120',
          '-y',
          '50',
        );
        await t.paneShows(session, 'glass-ui');
        for (let i = 0; i < 3; i++) await t.executor.poll();
        if (!shipContent) {
          expect(screens()).toEqual([]);
          await t.tmux('kill-session', '-t', `=${session}:`);
          continue;
        }
        expect(screens()).toEqual([
          expect.objectContaining({
            header: 'glass-ui',
            text: 'SelectionBar is missing in glass-ui — what now?',
            other: true,
          }),
        ]);
        // The question event follows the screen it names.
        const types = t.events.map((e) => e.type);
        expect(types.indexOf('card_run.pending_question')).toBeLessThan(
          types.indexOf('card_run.question'),
        );
        await t.tmux('send-keys', '-t', `=${session}:`, 'Enter');
        await t.paneShows(session, 'auto mode on');
        for (let i = 0; i < 3; i++) await t.executor.poll();
        expect(screens()).toHaveLength(2);
        expect(screens()[1]).toBeNull();
        await t.tmux('kill-session', '-t', `=${session}:`);
      }
    });

    it('#624: trusts the worktree before the launch; a dialog still up after the wait is reported once, never answered', async () => {
      const t = await setup();
      await t.executor.run(
        t.args({
          cardId: 'card_t',
          runId: 'run_t',
          profileKey: 'claude-trust',
        }),
      );
      const worktree = join(t.f.ws, '.wt-widget-card-ab12cd34');
      const config = JSON.parse(
        readFileSync(join(t.f.profileDir, '.claude.json'), 'utf8'),
      );
      expect(config.projects[worktree]).toEqual({
        hasTrustDialogAccepted: true,
      });

      const session = 'nautelle-card-ab12cd34';
      const dialogs = () =>
        t.events.filter((e) => e.type === 'card_run.dialog');
      await t.paneShows(session, 'Do you trust the files');
      await t.executor.poll();
      t.clock.advance(CARD_DIALOG_WAIT_MS - 1);
      await t.executor.poll();
      expect(dialogs()).toEqual([]);
      t.clock.advance(1);
      for (let i = 0; i < 3; i++) await t.executor.poll();
      expect(dialogs().map((e) => e.data)).toEqual([
        {
          cardId: 'card_t',
          runId: 'run_t',
          projectId: expect.any(String),
          at: expect.any(String),
          dialog: 'trust',
        },
      ]);
      expect(t.tmuxCalls.some((c) => c.includes('send-keys'))).toBe(false);
      await t.tmux('kill-session', '-t', `=${session}:`);
    });

    it('never answers a permission prompt (#435)', async () => {
      const t = await setup();
      await t.executor.run(
        t.args({
          cardId: 'card_p',
          runId: 'run_p',
          profileKey: 'claude-permission',
        }),
      );
      await t.argvOf('run_p');
      await Bun.sleep(300);
      for (let i = 0; i < 3; i++) await t.executor.poll();
      expect(t.tmuxCalls.some((c) => c.includes('send-keys'))).toBe(false);
      await t.tmux('kill-session', '-t', '=nautelle-card-ab12cd34');
    });

    it('creates .wt-<repo>-card-<shortid> and tmux nautelle-card-<shortid>, commits files first, launches argv only, emits ended when tmux exits', async () => {
      const t = await setup();
      const spec = '# C-12 Export as CSV\n\nAcceptance: a CSV.\n';
      const result = await t.executor.run(
        t.args({
          files: [{ path: 'docs/specs/card-12-export-csv.md', content: spec }],
        }),
      );
      expect(result).toEqual({
        phase: 'running',
        tmuxSession: 'nautelle-card-ab12cd34',
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
      expect(created).toContain('nautelle-card-ab12cd34');
      expect(created?.slice(-4)).toEqual([
        process.execPath,
        MAIN,
        'exec-run',
        join(t.cardsDir, 'card_1', 'rounds', 'run_1'),
      ]);

      // The binary received the prompt as one element, metacharacters intact.
      const argv = await t.argvOf('run_1');
      // #367 D1: the profile has no nautelle plugin — the round's wiring.
      const roundDir = join(t.cardsDir, 'card_1', 'rounds', 'run_1');
      expect(argv).toEqual([
        '--strict-mcp-config',
        '--session-id',
        SESSION_ID,
        '--settings',
        join(roundDir, 'nautelle-settings.json'),
        '--mcp-config',
        join(roundDir, 'nautelle-mcp.json'),
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
        readFileSync(join(roundDir, 'nautelle-mcp.json'), 'utf8'),
      );
      expect(mcp.mcpServers.nautelle).toEqual({
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
        tmuxSession: 'nautelle-card-ab12cd34',
        worktree,
        exitCode: 3,
      });
      // Reported once.
      await t.executor.poll();
      expect(t.phases('run_1').filter((d) => d.phase === 'ended')).toHaveLength(
        1,
      );
    });

    it('#367 D2: a profile that reports the nautelle plugin launches without --settings and --mcp-config', async () => {
      const t = await setup();
      t.f.write(t.f.profileDir, {
        'plugins/installed_plugins.json': JSON.stringify({
          plugins: {
            'nautelle@nautelle': [
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
          join(t.cardsDir, 'card_1', 'rounds', 'run_1', 'nautelle-mcp.json'),
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
          'nautelle-settings.json',
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
      expect(await t.alive('nautelle-card-ab12cd34')).toBe(true);

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
      expect(await t.alive('nautelle-card-ab12cd34')).toBe(false);
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

    it('#449 D3: with Token saver on, a cold long session restarts fresh from the note; the old session stays recorded', async () => {
      const t = await setup({ handoff: true });
      const tokenSaver = { enabled: true, mcpAllow: [] };
      const cardPrompt = `Intro.\n\n## Card C-12: Export CSV\n\n${PROMPT}`;
      await t.executor.run(
        t.args({ profileKey: 'claude-slow', prompt: cardPrompt, tokenSaver }),
      );
      expect((await t.argvOf('run_1')).slice(1, 3)).toEqual([
        '--session-id',
        SESSION_ID,
      ]);
      const worktree = join(t.f.ws, '.wt-widget-card-ab12cd34');
      mkdirSync(join(worktree, '.agentdock'), { recursive: true });
      await Bun.write(
        join(worktree, '.agentdock', 'handoff.md'),
        validNote('Export the table as CSV.', '1. Quote the commas.'),
      );
      const projects = join(t.f.profileDir, 'projects', '-wt');
      mkdirSync(projects, { recursive: true });
      await Bun.write(
        join(projects, `${SESSION_ID}.jsonl`),
        `${assistantLine({ at: '2026-10-14T08:00:00.000Z', id: 'm1', cacheRead: 150_000 })}\n`,
      );

      await t.executor.run(
        t.args({
          runId: 'run_2',
          profileKey: 'claude-slow',
          session: { id: SESSION_ID, resume: true },
          prompt: 'continue',
          tokenSaver,
        }),
      );
      const argv = await t.argvOf('run_2');
      expect(argv[1]).toBe('--session-id');
      const fresh = argv[2] ?? '';
      expect(fresh).not.toBe(SESSION_ID);
      expect(argv.join('\n')).toContain('1. Quote the commas.');
      expect(t.executor.store.load('card_1')?.sessionId).toBe(fresh);
      const restarts = t.events
        .filter((e) => e.type === 'round.restart')
        .map((e) => e.data);
      expect(restarts).toEqual([
        expect.objectContaining({ runId: 'run_1', mode: 'first' }),
        expect.objectContaining({
          runId: 'run_2',
          mode: 'fresh',
          sessionId: fresh,
          previousSessionId: SESSION_ID,
          estimate: expect.objectContaining({
            resumeTokens: 150_000,
            cacheWarm: false,
          }),
        }),
      ]);
    });

    it('#449: without Token saver a round launches as the API asked, with no restart event', async () => {
      const t = await setup({ handoff: true });
      await t.executor.run(t.args({ profileKey: 'claude-slow' }));
      expect((await t.argvOf('run_1')).slice(1, 3)).toEqual([
        '--session-id',
        SESSION_ID,
      ]);
      expect(t.events.some((e) => e.type === 'round.restart')).toBe(false);
    });

    it('a restarted runner keeps watching a live session and reports its end', async () => {
      const t = await setup();
      await t.executor.run(t.args({ profileKey: 'claude-slow' }));
      t.executor.stop();
      const next = t.make();
      await next.start();
      teardown.push(async () => next.stop());
      expect(next.cardSession(t.f.project.id, t.f.root, 'card_1')).toBe(
        'nautelle-card-ab12cd34',
      );
      await t.tmux('kill-session', '-t', '=nautelle-card-ab12cd34');
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
        body: 'Work.\n\nNautelle-Card: C-12',
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
          protectedPaths: [],
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
        body: 'Exported.\n\nNautelle-Card: C-12',
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

const STEWARD: StewardRunnerConfig = {
  enabled: true,
  silenceMinutes: 10,
  trailerGuard: true,
};

describe.skipIf(!tmuxInstalled)('Steward on card rounds (#447)', () => {
  /** What `card.resume` gets for round `run_1` of `card_1`. */
  const resumeArgs = (t: Awaited<ReturnType<typeof setup>>) => ({
    cardId: 'card_1',
    projectId: t.f.project.id,
    runId: 'run_1',
    root: t.f.root,
    base: 'main',
    shortId: 'ab12cd34',
    branch: 'card/c12-export-csv',
    sessionId: SESSION_ID,
    profileKey: 'claude-quick',
    model: 'opus' as const,
    permissionMode: 'acceptEdits' as const,
  });

  it('D10: a dead session is resumed with --resume in the same worktree and runs again', async () => {
    const t = await setup({ steward: STEWARD });
    await t.executor.run(t.args());
    await t.argvOf('run_1');
    await t.untilEnded(t.executor, 'run_1');
    // The recorded argv is replaced by the resumed launch's.
    rmSync(join(t.f.ws, 'argv-run_1'));

    expect(await t.executor.resume(resumeArgs(t))).toEqual({
      outcome: 'resumed',
      tmuxSession: 'nautelle-card-ab12cd34',
    });
    const argv = await t.argvOf('run_1');
    const worktree = join(t.f.ws, '.wt-widget-card-ab12cd34');
    expect(argv.slice(0, 3)).toEqual([
      '--strict-mcp-config',
      '--resume',
      SESSION_ID,
    ]);
    expect(argv.slice(-2)).toEqual([STEWARD_RESUME_TEXT, worktree]);
    expect(t.phases('run_1').map((d) => d.phase)).toEqual([
      'starting',
      'running',
      'ended',
      'running',
    ]);
  });

  it('DA-15: a resume naming another mode than the round started in is refused', async () => {
    const t = await setup({ steward: STEWARD });
    await t.executor.run(t.args());
    await t.argvOf('run_1');
    await t.untilEnded(t.executor, 'run_1');
    expect(t.executor.store.load('card_1')?.permissionMode).toBe('acceptEdits');

    expect(
      await failure(
        t.executor.resume({
          ...resumeArgs(t),
          permissionMode: 'bypassPermissions',
        }),
      ),
    ).toBe('invalid_args');
    expect(await t.alive('nautelle-card-ab12cd34')).toBe(false);
  });

  it('DA-15: a round with no recorded mode is not resumed', async () => {
    const t = await setup({ steward: STEWARD });
    await t.executor.run(t.args());
    await t.argvOf('run_1');
    await t.untilEnded(t.executor, 'run_1');
    const record = t.executor.store.load('card_1');
    if (!record) throw new Error('expected the record');
    delete record.permissionMode;
    t.executor.store.save(record);
    expect(await failure(t.executor.resume(resumeArgs(t)))).toBe('not_found');
  });

  it('D10: an alive session is left alone; a missing worktree starts nothing; a stopped round is never resumed', async () => {
    const t = await setup({ steward: STEWARD });
    await t.executor.run(t.args({ profileKey: 'claude-slow' }));
    await t.argvOf('run_1');
    expect(await t.executor.resume(resumeArgs(t))).toEqual({
      outcome: 'alive',
      tmuxSession: 'nautelle-card-ab12cd34',
    });

    // A person's stop.
    await t.executor.stopCard({ cardId: 'card_1', projectId: t.f.project.id });
    expect(await failure(t.executor.resume(resumeArgs(t)))).toBe('not_found');
    expect(await t.alive('nautelle-card-ab12cd34')).toBe(false);

    // A crash, then the worktree is gone.
    const u = await setup({ steward: STEWARD });
    await u.executor.run(u.args());
    await u.untilEnded(u.executor, 'run_1');
    rmSync(join(u.f.ws, '.wt-widget-card-ab12cd34'), {
      recursive: true,
      force: true,
    });
    expect(await u.executor.resume(resumeArgs(u))).toEqual({
      outcome: 'no_worktree',
    });
    expect(await u.alive('nautelle-card-ab12cd34')).toBe(false);
  });

  it('D11: with Steward on, the poll leaves a known dialog to the API; dismissDialog answers it', async () => {
    const t = await setup({ steward: STEWARD });
    await t.executor.run(
      t.args({ cardId: 'card_1', runId: 'run_d', profileKey: 'claude-dialog' }),
    );
    const keyFile = join(t.f.ws, 'key-run_d');
    const session = 'nautelle-card-ab12cd34';
    await t.paneShows(session, 'Not now');
    for (let i = 0; i < 3; i++) await t.executor.poll();
    expect(t.tmuxCalls.some((c) => c.includes('send-keys'))).toBe(false);

    expect(await t.executor.dismissDialog(session, 'teach-auto-mode')).toBe(
      true,
    );
    const keyRead = () =>
      existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '';
    for (let i = 0; i < 400 && keyRead() === ''; i++) await Bun.sleep(25);
    expect(keyRead()).toBe('1b');
  });

  it('D7: a trailer commit is not pushed, is reported, and the worker at its prompt gets the list', async () => {
    const t = await setup({ steward: STEWARD });
    await t.executor.run(
      t.args({
        profileKey: 'claude-prompt',
        pullRequest: cardDraftPullRequest({
          number: 12,
          title: 'Export as CSV',
          issueNumber: null,
        }),
      }),
    );
    await t.argvOf('run_1');
    const worktree = join(t.f.ws, '.wt-widget-card-ab12cd34');
    t.f.write(worktree, { 'src/export.ts': 'export const csv = 1;\n' });
    const sha = await t.f.commitAll(
      worktree,
      'feat: export\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
    );
    // Wait for the fake prompt box.
    await t.paneShows('nautelle-card-ab12cd34', '│ >');

    await t.executor.poll();
    await t.executor.settled();
    expect(
      await t.f
        .run(
          t.f.origin,
          'rev-parse',
          '--verify',
          '--quiet',
          'refs/heads/card/c12-export-csv',
        )
        .catch(() => null),
    ).toBeNull();
    expect(t.events.some((e) => e.type === 'card_run.pushed')).toBe(false);
    const steward = t.events.filter(
      (e) =>
        e.type === STEWARD_OBSERVED_EVENT || e.type === STEWARD_ACTED_EVENT,
    );
    expect(steward.map((e) => e.type)).toEqual([
      STEWARD_OBSERVED_EVENT,
      STEWARD_ACTED_EVENT,
    ]);
    expect(steward[0]?.data).toMatchObject({ kind: 'trailer' });
    expect(steward[1]?.data).toMatchObject({
      action: 'hold_push',
      result: 'ok',
      detail: '1 commit to rewrite',
    });

    const typedFile = join(t.f.ws, 'typed-run_1');
    for (let i = 0; i < 400 && !existsSync(typedFile); i++) await Bun.sleep(25);
    const typed = readFileSync(typedFile, 'utf8');
    expect(typed).toContain(sha.slice(0, 12));
    expect(typed).toContain('do not push');

    // The same held head is reported once.
    t.clock.advance(CARD_PUSH_MIN_INTERVAL_MS);
    await t.executor.poll();
    await t.executor.settled();
    const acted = t.events.filter((e) => e.type === STEWARD_ACTED_EVENT);
    expect(acted).toHaveLength(1);
  });
});
