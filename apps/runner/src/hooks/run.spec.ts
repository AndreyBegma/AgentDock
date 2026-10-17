import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionRequestSummary } from '@agentdock/shared';
import { CardStore } from '../cards/record';
import { HandoffStateStore } from '../handoff/state';
import { validNote } from '../handoff/testing';
import { type LocalHandler, LocalSocketServer } from '../local/server';
import type { LocalResult } from '../local/types';
import { fakeExec, memoryLogger, tempDir } from '../testing/fixtures';
import { clipToolInput, PERMISSION_TOOL_INPUT_MAX } from './permission';
import { type HookDeps, runHook } from './run';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, 'fixtures', `${name}.json`), 'utf8');

const summary = (
  status: ActionRequestSummary['status'],
  note: string | null = null,
): ActionRequestSummary => ({
  id: 'ar_1',
  projectId: 'prj_app',
  runnerId: 'rn_1',
  sessionId: null,
  requestedById: 'u_1',
  kind: 'tool_use',
  summary: 'Allow Bash',
  args: { toolName: 'Bash' },
  status,
  decidedById: null,
  decidedAt: null,
  note,
  expiresAt: '2026-10-14T10:05:00.000Z',
  createdAt: '2026-10-14T10:00:00.000Z',
});

interface Call {
  op: string;
  args: Record<string, unknown>;
  token?: string;
}

describe('agentdock-runner hook (spec 201 D11–D17)', () => {
  let dir = '';
  let cleanup = () => {};
  let server: LocalSocketServer | null = null;
  let calls: Call[] = [];
  let stdout: string[] = [];

  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
    calls = [];
    stdout = [];
  });
  afterEach(() => {
    server?.stop();
    server = null;
    cleanup();
  });

  const socketPath = () => join(dir, 'runner.sock');

  const daemon = (
    answer: (
      call: Call,
    ) => LocalResult<unknown> | Promise<LocalResult<unknown>>,
  ) => {
    const handle: LocalHandler = async (op, args, caller) => {
      const call = {
        op,
        args: args as Record<string, unknown>,
        ...(caller.token ? { token: caller.token } : {}),
      };
      calls.push(call);
      return answer(call);
    };
    server = new LocalSocketServer({
      path: socketPath(),
      handle,
      log: memoryLogger().log,
    });
    server.start();
  };

  let clock = 0;
  const deps = (
    stdin: string,
    overrides: Partial<HookDeps> = {},
  ): HookDeps => ({
    env: { AGENTDOCK_TMUX_SESSION: 'agentdock-manual-0a1b2c3d' },
    os: 'linux',
    socketPath: socketPath(),
    cwd: '/home/person/dev/app',
    ppid: 300,
    stdin: () => new Response(stdin).body as ReadableStream<Uint8Array>,
    stdout: (text) => stdout.push(text),
    stderr: () => {},
    exec: fakeExec({
      'git -C /home/person/dev/app rev-parse --abbrev-ref HEAD': 'feat/184-x\n',
    }),
    readFile: (path) => {
      if (path === '/proc/300/stat') return '300 (claude) S 200 0 0';
      if (path === '/proc/200/stat') return '200 (zsh) S 1 0 0';
      throw new Error('ENOENT');
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    // Never the real card store of the machine running the tests.
    cardsDir: join(dir, 'no-cards'),
    ...overrides,
  });

  it('exits 0 within 1 s and prints nothing when the daemon is down', async () => {
    const started = Date.now();
    for (const name of ['session-start', 'permission-request', 'stop']) {
      expect(await runHook([name], deps(fixture(name)))).toBe(0);
    }
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(stdout).toEqual([]);
  });

  it('exits 0 at once and prints nothing under AGENTDOCK_HOOKS=off (#244 D4)', async () => {
    daemon(() => ({ ok: true, data: { text: 'Project app, base develop.' } }));
    for (const name of ['session-start', 'permission-request', 'stop']) {
      const outcome = await runHook(
        [name],
        deps(fixture(name), { env: { AGENTDOCK_HOOKS: 'off' } }),
      );
      expect(outcome).toBe(0);
    }
    expect(calls).toEqual([]);
    expect(stdout).toEqual([]);
  });

  it('session-start reports the event with branch, tmux and ancestors, then prints additionalContext', async () => {
    daemon(({ op }) =>
      op === 'request'
        ? { ok: true, data: { text: 'Project app, base develop.' } }
        : { ok: true, data: { queued: true } },
    );
    expect(
      await runHook(['session-start'], deps(fixture('session-start'))),
    ).toBe(0);
    expect(calls.map((c) => c.op)).toEqual(['event', 'request']);
    expect(calls[0]?.args).toMatchObject({
      type: 'hook.session_started',
      sessionId: '0c9e2f4a-5b1d-4e8a-9c3f-2a7b6d1e8f90',
      data: {
        gitBranch: 'feat/184-x',
        tmuxSession: 'agentdock-manual-0a1b2c3d',
      },
      ancestors: [
        { pid: 300, comm: 'claude' },
        { pid: 200, comm: 'zsh' },
      ],
    });
    expect(calls[1]?.args).toEqual({
      method: 'context.sessionStart',
      args: { gitBranch: 'feat/184-x' },
      via: 'hook',
      cwd: '/home/person/dev/app',
      sessionId: '0c9e2f4a-5b1d-4e8a-9c3f-2a7b6d1e8f90',
    });
    expect(JSON.parse(stdout.join(''))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'Project app, base develop.',
      },
    });
  });

  describe('the card note at session start (#449 D6, D8)', () => {
    const cardSetup = () => {
      const worktree = join(dir, '.wt-app-card-ab12cd34');
      const cardsDir = join(dir, 'cards');
      mkdirSync(join(worktree, '.agentdock'), { recursive: true });
      const store = new CardStore(cardsDir);
      store.save({
        cardId: 'cmcard01',
        projectId: 'p1',
        root: join(dir, 'app'),
        repo: 'acme/app',
        shortId: 'ab12cd34',
        worktree,
        branch: 'card/c12-add-login',
        base: 'main',
        tmuxSession: 'agentdock-card-ab12cd34',
        runId: 'run_1',
        phase: 'ended',
        startedAt: '2026-10-16T10:00:00.000Z',
      });
      new HandoffStateStore((id) => store.dir(id)).save('cmcard01', {
        note: {
          content: validNote('Ship the login page.'),
          personLines: [],
          updatedBy: 'agent',
          updatedAt: '2026-10-16T11:00:00.000Z',
        },
        number: 12,
        asked: [],
        sessions: [],
      });
      const input = (source: string) =>
        JSON.stringify({
          ...JSON.parse(fixture('session-start')),
          cwd: worktree,
          source,
        });
      return { worktree, cardsDir, input };
    };
    const context = () =>
      JSON.parse(stdout.join('')).hookSpecificOutput.additionalContext;

    it('adds the note after the project context for a person’s session', async () => {
      const c = cardSetup();
      daemon(({ op }) =>
        op === 'request'
          ? { ok: true, data: { text: 'Project app, base develop.' } }
          : { ok: true, data: { queued: true } },
      );
      await runHook(
        ['session-start'],
        deps(c.input('startup'), { cwd: c.worktree, cardsDir: c.cardsDir }),
      );
      expect(context()).toStartWith('Project app, base develop.\n\n');
      expect(context()).toContain('AgentDock card C-12');
      expect(context()).toContain('Ship the login page.');
    });

    it('reaches the session with the daemon down', async () => {
      const c = cardSetup();
      await runHook(
        ['session-start'],
        deps(c.input('resume'), { cwd: c.worktree, cardsDir: c.cardsDir }),
      );
      expect(context()).toContain('Ship the login page.');
    });

    it('gives the card’s own worker the note only after a compaction', async () => {
      const c = cardSetup();
      const env = { AGENTDOCK_CARD: 'ab12cd34' };
      await runHook(
        ['session-start'],
        deps(c.input('startup'), {
          env,
          cwd: c.worktree,
          cardsDir: c.cardsDir,
        }),
      );
      expect(stdout).toEqual([]);
      await runHook(
        ['session-start'],
        deps(c.input('compact'), {
          env,
          cwd: c.worktree,
          cardsDir: c.cardsDir,
        }),
      );
      expect(context()).toContain('Ship the login page.');
      expect(context()).not.toContain('older than the last commit');
    });

    it('#494: the worker’s start after a compaction carries the request owed before it', async () => {
      const c = cardSetup();
      const env = { AGENTDOCK_CARD: 'ab12cd34' };
      const state = new HandoffStateStore((id) =>
        new CardStore(c.cardsDir).dir(id),
      );
      state.update('cmcard01', (s) => {
        s.compactAsk = 'run_1';
      });
      await runHook(
        ['session-start'],
        deps(c.input('compact'), {
          env,
          cwd: c.worktree,
          cardsDir: c.cardsDir,
        }),
      );
      expect(context()).toContain(
        'The note is older than the last commit: update it first',
      );
      expect(context()).toContain('Ship the login page.');
      // Owed to an older round: not this one's request.
      stdout = [];
      state.update('cmcard01', (s) => {
        s.compactAsk = 'run_0';
      });
      await runHook(
        ['session-start'],
        deps(c.input('compact'), {
          env,
          cwd: c.worktree,
          cardsDir: c.cardsDir,
        }),
      );
      expect(context()).not.toContain('older than the last commit');
    });
  });

  it('session-start prints nothing when the context is empty or refused', async () => {
    daemon(({ op }) =>
      op === 'request'
        ? { ok: false, error: { code: 'no_project' } }
        : { ok: true, data: { queued: true } },
    );
    await runHook(['session-start'], deps(fixture('session-start')));
    expect(stdout).toEqual([]);
  });

  describe('the session token (#113)', () => {
    const SESSION = '0c9e2f4a-5b1d-4e8a-9c3f-2a7b6d1e8f90';
    const tokens = () => join(dir, 'session-tokens');

    it('registers at SessionStart, keeps the token it is given and presents it on the session’s later hooks', async () => {
      daemon(({ op, args }) =>
        op === 'request'
          ? { ok: true, data: { text: '' } }
          : args.type === 'hook.session_started'
            ? { ok: true, data: { queued: true, token: 'tok-1' } }
            : { ok: true, data: { queued: true } },
      );
      await runHook(['session-start'], deps(fixture('session-start')));
      expect(calls.map((c) => [c.op, c.token])).toEqual([
        ['event', undefined],
        ['request', 'tok-1'],
      ]);
      // By session id for its hooks, by its claude pid (300) for its MCP.
      expect(existsSync(join(tokens(), `s-${SESSION}.json`))).toBe(true);
      expect(existsSync(join(tokens(), 'p-300.json'))).toBe(true);

      calls = [];
      await runHook(['post-tool-use'], deps(fixture('post-tool-use')));
      expect(calls.map((c) => c.token)).toEqual(['tok-1']);

      await runHook(['session-end'], deps(fixture('session-end')));
      expect(existsSync(join(tokens(), `s-${SESSION}.json`))).toBe(false);
      expect(existsSync(join(tokens(), 'p-300.json'))).toBe(false);
    });

    it('presents the token a launched session has in its env from the first hook', async () => {
      daemon(({ op }) =>
        op === 'request'
          ? { ok: true, data: { text: '' } }
          : { ok: true, data: { queued: true, token: 'tok-env' } },
      );
      const env = {
        AGENTDOCK_SESSION_TOKEN: 'tok-env',
        AGENTDOCK_TMUX_SESSION: 'agentdock-manual-0a1b2c3d',
      };
      await runHook(['session-start'], deps(fixture('session-start'), { env }));
      await runHook(['stop'], deps(fixture('stop'), { env }));
      expect(calls.map((c) => c.token)).toEqual([
        'tok-env',
        'tok-env',
        'tok-env',
      ]);
    });
  });

  it('an async hook only reports its event', async () => {
    daemon(() => ({ ok: true, data: { queued: true } }));
    await runHook(['post-tool-use'], deps(fixture('post-tool-use')));
    expect(calls.map((c) => c.op)).toEqual(['event']);
    expect(calls[0]?.args).toMatchObject({
      type: 'hook.tool_finished',
      content: { input: { truncated: false }, output: { truncated: false } },
    });
    expect(stdout).toEqual([]);
  });

  it('stop reports the background tasks its transcript says still run (#390)', async () => {
    daemon(() => ({ ok: true, data: { queued: true } }));
    const transcript = join(dir, 'session.jsonl');
    await Bun.write(
      transcript,
      [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tu_1',
                name: 'Bash',
                input: {
                  command: 'bunx jest --selectProjects e2e',
                  run_in_background: true,
                },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: { content: [{ tool_use_id: 'tu_1', type: 'tool_result' }] },
          toolUseResult: { backgroundTaskId: 'b1' },
        }),
      ].join('\n'),
    );
    const input = {
      ...JSON.parse(fixture('stop')),
      transcript_path: transcript,
    };
    await runHook(
      ['stop'],
      deps(JSON.stringify(input), {
        readFile: (path) => readFileSync(path, 'utf8'),
      }),
    );
    expect(calls[0]?.args).toMatchObject({
      type: 'hook.stopped',
      data: { backgroundTasks: 1 },
      content: {
        background: {
          text: 'bunx jest --selectProjects e2e',
          truncated: false,
        },
      },
    });
  });

  it('stop without a readable transcript reports no background count', async () => {
    daemon(() => ({ ok: true, data: { queued: true } }));
    await runHook(['stop'], deps(fixture('stop')));
    expect(calls[0]?.args).toMatchObject({ type: 'hook.stopped', data: {} });
    expect(
      (calls[0]?.args.data as Record<string, unknown>).backgroundTasks,
    ).toBeUndefined();
  });

  it('an unknown hook name or bad stdin exits 0 silently', async () => {
    daemon(() => ({ ok: true, data: null }));
    expect(await runHook(['pre-compact'], deps('{}'))).toBe(0);
    expect(await runHook(['stop'], deps('not json'))).toBe(0);
    expect(calls).toEqual([]);
  });

  describe('permission-request', () => {
    const away = (
      on: boolean,
      statuses: (LocalResult<unknown> | ActionRequestSummary)[],
      created: LocalResult<unknown> = { ok: true, data: summary('pending') },
    ) =>
      daemon(({ op, args }) => {
        if (op === 'ping') {
          return {
            ok: true,
            data: {
              pong: true,
              online: true,
              awayMode: on,
              projectId: 'prj_app',
            },
          };
        }
        if (op === 'event') return { ok: true, data: { queued: true } };
        if (args.method === 'action.request') return created;
        const next = statuses.shift() ?? summary('pending');
        return 'ok' in next ? next : { ok: true, data: next };
      });

    const run = () =>
      runHook(['permission-request'], deps(fixture('permission-request')));

    it('with away mode off reports the event and decides nothing, at once', async () => {
      away(false, []);
      const started = Date.now();
      await run();
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(calls.map((c) => c.op)).toEqual(['event', 'ping']);
      expect(stdout).toEqual([]);
    });

    it('with away mode on files a tool_use request and allows once approved', async () => {
      away(true, [summary('pending'), summary('approved')]);
      await run();
      const request = calls.find((c) => c.args.method === 'action.request');
      expect(request?.args).toMatchObject({
        args: {
          kind: 'tool_use',
          args: {
            toolName: 'Bash',
            input: expect.stringContaining('rm -rf node_modules'),
          },
        },
        via: 'hook',
        sessionId: '0c9e2f4a-5b1d-4e8a-9c3f-2a7b6d1e8f90',
      });
      expect(
        calls.filter((c) => c.args.method === 'action.status'),
      ).toHaveLength(2);
      expect(JSON.parse(stdout.join(''))).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' },
        },
      });
    });

    it('keeps head and tail of a tool input above the hook cap (C-114)', () => {
      const raw = `HEAD${'x'.repeat(PERMISSION_TOOL_INPUT_MAX * 2)}TAIL`;
      const clipped = clipToolInput(raw) ?? '';
      expect(clipped.length).toBeLessThanOrEqual(PERMISSION_TOOL_INPUT_MAX);
      expect(clipped.startsWith('HEAD')).toBe(true);
      expect(clipped.endsWith('TAIL')).toBe(true);
      expect(clipToolInput('{"command":"ls"}')).toBe('{"command":"ls"}');
    });

    it('denies with the approver note', async () => {
      away(true, [summary('denied', 'Not on prod, please.')]);
      await run();
      expect(JSON.parse(stdout.join(''))).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'deny', message: 'Not on prod, please.' },
        },
      });
    });

    it('prints nothing when the request expires', async () => {
      away(true, [summary('expired')]);
      await run();
      expect(stdout).toEqual([]);
    });

    it('prints nothing when the server cannot be reached', async () => {
      away(true, [], { ok: false, error: { code: 'runner_offline' } });
      await run();
      expect(stdout).toEqual([]);
    });

    it('gives up after ACTION_REQUEST_HOOK_WAIT_MS of pending', async () => {
      clock = 0;
      away(true, []);
      await run();
      expect(stdout).toEqual([]);
      const polls = calls.filter((c) => c.args.method === 'action.status');
      expect(polls).toHaveLength(140);
      expect(clock).toBe(280_000);
    });
  });
});
