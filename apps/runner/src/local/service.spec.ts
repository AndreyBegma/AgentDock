import { describe, expect, it } from 'bun:test';
import {
  HOOK_CONTENT_MAX_CHARS,
  parseHookEvent,
  type UnsequencedEvent,
  type WatchedProject,
} from '@agentdock/shared/protocol';
import { memoryLogger } from '../testing/fixtures';
import { LocalService } from './service';
import { HookSessions } from './sessions';
import type { LocalRelayRequest, LocalResult } from './types';

const ROOT = '/home/person/dev/app';
const GHP = `ghp_${'b'.repeat(36)}`;
const KEY = '-----BEGIN PRIVATE KEY-----\nMIIsecret\n-----END PRIVATE KEY-----';

const setup = (shipContent: boolean, online = true) => {
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
      return { ok: true, data: { echoed: true } };
    },
    envelope: async (id) =>
      id === 'prj_app' ? { repo: 'acme/app', root: ROOT } : undefined,
    sessions,
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
