import { describe, expect, it } from 'bun:test';
import {
  HOOK_CONTENT_MAX_CHARS,
  parseHookEvent,
  type UnsequencedEvent,
  type WatchedProject,
} from '@agentdock/shared/protocol';
import type { CardRecord } from '../cards/record';
import { memoryLogger } from '../testing/fixtures';
import { LocalService } from './service';
import { HookSessions } from './sessions';
import type { LocalRelayRequest, LocalResult } from './types';

const ROOT = '/home/person/dev/app';
const GHP = `ghp_${'b'.repeat(36)}`;
const KEY = '-----BEGIN PRIVATE KEY-----\nMIIsecret\n-----END PRIVATE KEY-----';

interface SetupOptions {
  liveRound?: (cwd: string) => CardRecord | null;
  reply?: LocalResult<unknown>;
}

const setup = (
  shipContent: boolean,
  online = true,
  options: SetupOptions = {},
) => {
  const emitted: UnsequencedEvent[] = [];
  const relayed: LocalRelayRequest[] = [];
  const sessions = new HookSessions();
  const projects: WatchedProject[] = [
    { id: 'prj_app', root: ROOT, ...(shipContent ? { shipContent } : {}) },
  ];
  const service = new LocalService({
    projects: () => projects,
    awayMode: () => true,
    online: () => online,
    emit: (event) => emitted.push(event),
    relay: async (request): Promise<LocalResult<unknown>> => {
      relayed.push(request);
      return options.reply ?? { ok: true, data: { echoed: true } };
    },
    envelope: async (id) =>
      id === 'prj_app' ? { repo: 'acme/app', root: ROOT } : undefined,
    sessions,
    ...(options.liveRound ? { liveRound: options.liveRound } : {}),
    now: () => '2026-10-14T10:00:00.000Z',
    log: memoryLogger().log,
  });
  return { service, emitted, relayed, sessions };
};

const prompt = (text: string, cwd = ROOT) => ({
  type: 'hook.prompt_submitted',
  sessionId: 's-1',
  cwd,
  data: { chars: text.length },
  content: { content: { text, truncated: false } },
});

describe('LocalService — hook events (spec 201 D11, D13)', () => {
  it('spools a valid hook event with source hook, project and session', async () => {
    const { service, emitted } = setup(false);
    const result = await service.handle('event', prompt('hi'));
    expect(result).toEqual({ ok: true, data: { queued: true } });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      v: 1,
      ts: '2026-10-14T10:00:00.000Z',
      type: 'hook.prompt_submitted',
      source: 'hook',
      project: { repo: 'acme/app', root: ROOT },
      session: { runtime: 'claude', id: 's-1' },
      data: { chars: 2 },
    });
    const parsed = parseHookEvent({ ...emitted[0], seq: 1 });
    expect(parsed?.ok).toBe(true);
  });

  it('strips every content field when the project does not ship content', async () => {
    const { service, emitted } = setup(false);
    await service.handle('event', {
      type: 'hook.tool_finished',
      sessionId: 's-1',
      cwd: ROOT,
      data: { toolUseId: 't1', toolName: 'Bash', ok: true },
      content: {
        input: { text: '{"command":"ls"}', truncated: false },
        output: { text: 'a\nb', truncated: false },
      },
    });
    expect(JSON.stringify(emitted)).not.toContain('command');
    expect(emitted[0]?.data).toEqual({
      toolUseId: 't1',
      toolName: 'Bash',
      ok: true,
    });
  });

  it('gates the background command of a stop like any content (#390)', async () => {
    const stop = {
      type: 'hook.stopped',
      sessionId: 's-1',
      cwd: ROOT,
      data: { backgroundTasks: 2 },
      content: {
        background: { text: `bun test --token ${GHP}`, truncated: false },
      },
    };
    const off = setup(false);
    await off.service.handle('event', stop);
    expect(off.emitted[0]?.data).toEqual({ backgroundTasks: 2 });
    const on = setup(true);
    await on.service.handle('event', stop);
    const data = on.emitted[0]?.data as {
      backgroundTasks: number;
      background: { text: string };
    };
    expect(data.backgroundTasks).toBe(2);
    expect(data.background.text).toContain('bun test');
    expect(data.background.text).not.toContain('ghp_');
  });

  it('never ships content for a cwd outside every watched root', async () => {
    const { service, emitted } = setup(true);
    await service.handle('event', prompt(`secret ${GHP}`, '/tmp/elsewhere'));
    expect(emitted[0]?.project).toBeUndefined();
    expect(emitted[0]?.data).toEqual({ chars: `secret ${GHP}`.length });
  });

  it('redacts and caps content when the project ships it', async () => {
    const { service, emitted } = setup(true);
    await service.handle('event', prompt(`token ${GHP}\n${KEY}`));
    await service.handle('event', prompt('y'.repeat(20 * 1024)));
    const [first, second] = emitted.map(
      (e) =>
        (e.data as { content: { text: string; truncated: boolean } }).content,
    );
    expect(first?.text).not.toContain('ghp_');
    expect(first?.text).not.toContain('MIIsecret');
    expect(first?.truncated).toBe(false);
    expect(second?.text).toHaveLength(HOOK_CONTENT_MAX_CHARS);
    expect(second?.truncated).toBe(true);
  });

  it('refuses an event whose data fails its schema, and spools nothing', async () => {
    const { service, emitted } = setup(false);
    const result = await service.handle('event', {
      type: 'hook.session_ended',
      sessionId: 's-1',
      cwd: ROOT,
      data: { reason: 'boom', extra: 1 },
    });
    expect(result.ok).toBe(false);
    expect(emitted).toEqual([]);
  });

  it('records the claude pid of a session start for MCP lookups (D10)', async () => {
    const { service, sessions } = setup(false);
    await service.handle('event', {
      type: 'hook.session_started',
      sessionId: 's-9',
      cwd: ROOT,
      data: { source: 'startup', cwd: ROOT, permissionMode: 'default' },
      ancestors: [
        { pid: 400, comm: 'sh' },
        { pid: 300, comm: 'claude' },
        { pid: 200, comm: 'zsh' },
      ],
    });
    expect(sessions.resolve(300, undefined)).toBe('s-9');
    expect(sessions.projectOf('s-9', [{ id: 'prj_app', root: ROOT }])).toBe(
      'prj_app',
    );
  });
});

describe('LocalService — requests (spec 201 D6, D9, D17)', () => {
  it('relays with the correlated project and the session from the pid map', async () => {
    const { service, relayed, sessions } = setup(false);
    sessions.started('s-1', `${ROOT}/src`, [{ pid: 77, comm: 'claude' }]);
    const result = await service.handle('request', {
      method: 'queue.list',
      args: { limit: 3 },
      via: 'mcp',
      cwd: `${ROOT}/src`,
      ppid: 77,
    });
    expect(result).toEqual({ ok: true, data: { echoed: true } });
    expect(relayed).toEqual([
      {
        method: 'queue.list',
        args: { limit: 3 },
        projectId: 'prj_app',
        session: { runtime: 'claude', id: 's-1' },
        via: 'mcp',
      },
    ]);
  });

  it('sends no project for a cwd outside every watched root', async () => {
    const { service, relayed } = setup(false);
    await service.handle('request', {
      method: 'fleet.status',
      args: {},
      via: 'mcp',
      cwd: '/tmp/x',
    });
    expect(relayed[0]).toEqual({
      method: 'fleet.status',
      args: {},
      via: 'mcp',
    });
  });

  const toolUse = (input: string) => ({
    method: 'action.request',
    args: {
      kind: 'tool_use',
      args: { toolName: 'Bash', input },
      summary: 'Allow Bash',
    },
    via: 'hook',
    cwd: ROOT,
    sessionId: 's-1',
  });

  it('drops the tool input of a tool_use request when the project ships no content', async () => {
    const { service, relayed } = setup(false);
    await service.handle('request', toolUse('{"command":"rm -rf /"}'));
    expect(relayed[0]?.args).toEqual({
      kind: 'tool_use',
      args: { toolName: 'Bash' },
      summary: 'Allow Bash',
    });
  });

  it('redacts and cuts the tool input to 500 characters when it ships content', async () => {
    const { service, relayed } = setup(true);
    await service.handle(
      'request',
      toolUse(`{"command":"echo ${GHP} ${'z'.repeat(900)}"}`),
    );
    const input = (relayed[0]?.args as { args: { input: string } }).args.input;
    expect(input).not.toContain('ghp_');
    expect(input.length).toBeLessThanOrEqual(500);
  });

  it('answers ping with away mode, liveness and the correlated project', async () => {
    const { service } = setup(false, false);
    expect(await service.handle('ping', { cwd: `${ROOT}/a` })).toEqual({
      ok: true,
      data: { pong: true, online: false, awayMode: true, projectId: 'prj_app' },
    });
  });
});

describe('LocalService — card rounds after a restart (#482)', () => {
  const WORKTREE = '/home/person/dev/.wt-app-card-abc12345';
  const SESSION = '0b0f6f2e-8f5e-4c1e-9a43-3d6f3b1f2c11';
  const round: CardRecord = {
    cardId: 'card_1',
    projectId: 'prj_app',
    root: ROOT,
    repo: 'acme/app',
    shortId: 'abc12345',
    worktree: WORKTREE,
    branch: 'fix/1-x',
    base: 'develop',
    tmuxSession: 'agentdock-card-abc12345',
    runId: 'run_1',
    phase: 'running',
    sessionId: SESSION,
    startedAt: '2026-10-14T09:00:00.000Z',
  };
  const liveRound = (cwd: string) => (cwd.startsWith(WORKTREE) ? round : null);
  const finish = {
    method: 'card.finish',
    args: { summary: 'Done. Tested.' },
    via: 'mcp',
    cwd: WORKTREE,
    ppid: 4242,
  };

  it('relays a finish_card with the session of the round whose worktree it runs in', async () => {
    const { service, relayed } = setup(false, true, { liveRound });
    const result = await service.handle('request', finish);
    expect(result.ok).toBe(true);
    expect(relayed[0]).toEqual({
      method: 'card.finish',
      args: { summary: 'Done. Tested.' },
      projectId: 'prj_app',
      session: { runtime: 'claude', id: SESSION },
      via: 'mcp',
    });
  });

  it('prefers the session a SessionStart reported for the parent pid', async () => {
    const { service, relayed, sessions } = setup(false, true, { liveRound });
    sessions.started('s-own', WORKTREE, [{ pid: 4242, comm: 'claude' }]);
    await service.handle('request', finish);
    expect(relayed[0]?.session).toEqual({ runtime: 'claude', id: 's-own' });
  });

  it('reports a refused finish_card of a live round as card_run.finish_refused', async () => {
    const { service, emitted } = setup(false, true, {
      liveRound,
      reply: {
        ok: false,
        error: {
          code: 'not_a_card_session',
          message: 'not a board card session',
        },
      },
    });
    const result = await service.handle('request', finish);
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'not_a_card_session',
        message: 'not a board card session',
      },
    });
    expect(emitted).toEqual([
      {
        v: 1,
        ts: '2026-10-14T10:00:00.000Z',
        type: 'card_run.finish_refused',
        source: 'runner',
        project: { repo: 'acme/app', root: ROOT },
        data: {
          cardId: 'card_1',
          runId: 'run_1',
          projectId: 'prj_app',
          at: '2026-10-14T10:00:00.000Z',
          code: 'not_a_card_session',
        },
      },
    ]);
  });

  it('reports nothing for a refused finish_card outside every card worktree, or another refused method', async () => {
    const reply: LocalResult<unknown> = {
      ok: false,
      error: { code: 'not_a_card_session' },
    };
    const { service, emitted } = setup(false, true, { liveRound, reply });
    await service.handle('request', { ...finish, cwd: ROOT });
    await service.handle('request', {
      method: 'queue.list',
      args: {},
      via: 'mcp',
      cwd: WORKTREE,
    });
    expect(emitted).toEqual([]);
  });
});
