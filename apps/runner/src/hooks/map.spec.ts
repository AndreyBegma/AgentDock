import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOOK_CLI_EVENT,
  HOOK_CLI_NAMES,
  type HookCliName,
  parseHookEvent,
  type UnsequencedEvent,
} from '@agentdock/shared/protocol';
import { LocalService } from '../local/service';
import { SessionTokens } from '../local/session-tokens';
import { HookSessions } from '../local/sessions';
import { memoryLogger } from '../testing/fixtures';
import { parseProcStat, readAncestors } from './ancestors';
import { buildHookEvent } from './map';
import {
  DEFAULT_DENY_MESSAGE,
  type PermissionDecision,
  permissionOutput,
} from './permission';

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(join(import.meta.dir, 'fixtures', `${name}.json`), 'utf8'),
  );

const NAMES = Object.keys(HOOK_CLI_NAMES) as HookCliName[];
const ROOT = '/home/person/dev/app';

const spool = async (shipContent: boolean, names = NAMES) => {
  const emitted: UnsequencedEvent[] = [];
  const tokens = new SessionTokens(Buffer.alloc(32, 1));
  const service = new LocalService({
    projects: () => [{ id: 'prj_app', root: ROOT, shipContent }],
    awayMode: () => false,
    online: () => true,
    emit: (event) => emitted.push(event),
    relay: async () => ({ ok: true, data: null }),
    envelope: async () => ({ repo: 'acme/app', root: ROOT }),
    sessions: new HookSessions(),
    tokens,
    now: () => '2026-10-14T10:00:00.000Z',
    log: memoryLogger().log,
  });
  for (const name of names) {
    const event = buildHookEvent(name, fixture(name), {
      gitBranch: 'feat/184-x',
      tmuxSession: 'agentdock-manual-0a1b2c3d',
      ancestors: [{ pid: 10, comm: 'claude' }],
    });
    if (!event) throw new Error(`${name} built nothing`);
    const token = tokens.mint({ sessionId: event.sessionId, cwd: event.cwd });
    const result = await service.handle('event', event, {
      token,
      peerPid: null,
    });
    if (!result.ok) throw new Error(`${name}: ${result.error.message}`);
  }
  return emitted;
};

describe('hook payloads → hook.* events (spec 201 D11)', () => {
  it('turns every documented hook payload into its event, valid against the shared schema', async () => {
    const emitted = await spool(true);
    expect(emitted.map((e) => e.type)).toEqual(
      NAMES.map((n) => HOOK_CLI_EVENT[n]),
    );
    for (const event of emitted) {
      expect(event.source).toBe('hook');
      const parsed = parseHookEvent({ ...event, seq: 1 });
      expect(parsed?.ok).toBe(true);
    }
  });

  it('maps the fields as D11 names them', async () => {
    const emitted = await spool(true);
    const byType = (type: string, n = 0) =>
      emitted.filter((e) => e.type === type)[n]?.data;
    expect(byType('hook.session_started')).toEqual({
      source: 'startup',
      cwd: ROOT,
      gitBranch: 'feat/184-x',
      model: 'claude-opus-5',
      permissionMode: 'default',
      tmuxSession: 'agentdock-manual-0a1b2c3d',
    });
    expect(byType('hook.tool_finished')).toMatchObject({
      toolUseId: 'toolu_01ABC123',
      toolName: 'Write',
      ok: true,
      durationMs: 12,
      input: {
        text: expect.stringContaining('file content'),
        truncated: false,
      },
    });
    expect(byType('hook.tool_finished', 1)).toMatchObject({
      toolUseId: 'toolu_01ABC124',
      ok: false,
      output: { text: expect.stringContaining('Cannot find module') },
    });
    expect(byType('hook.permission_requested')).toEqual({ toolName: 'Bash' });
    expect(byType('hook.notification')).toEqual({
      notificationType: 'permission_prompt',
    });
    // #494: the person's `/compact` text is never read.
    expect(byType('hook.pre_compact')).toEqual({ trigger: 'manual' });
    expect(byType('hook.session_ended')).toEqual({
      reason: 'prompt_input_exit',
    });
    expect(emitted[0]?.session).toEqual({
      runtime: 'claude',
      id: '0c9e2f4a-5b1d-4e8a-9c3f-2a7b6d1e8f90',
    });
  });

  it('carries no content field at all when the project ships none', async () => {
    const emitted = await spool(false);
    for (const event of emitted) {
      const data = event.data as Record<string, unknown>;
      for (const key of ['content', 'input', 'output', 'response']) {
        expect(data[key]).toBeUndefined();
      }
    }
    expect(JSON.stringify(emitted)).not.toContain('factorial');
  });

  it('falls back for values outside the shared enums', () => {
    const event = buildHookEvent('session-end', {
      session_id: 's',
      cwd: '/x',
      reason: 'something_new',
    });
    expect(event?.data).toEqual({ reason: 'other' });
    const start = buildHookEvent(
      'session-start',
      { session_id: 's', cwd: '/x', source: 'teleport' },
      { tmuxSession: 'not-ours' },
    );
    expect(start?.data).toEqual({
      source: 'startup',
      cwd: '/x',
      permissionMode: 'default',
    });
    const note = buildHookEvent('notification', {
      session_id: 's',
      cwd: '/x',
      notification_type: 'Idle-Prompt!',
    });
    expect(note?.data).toEqual({ notificationType: 'idle_prompt' });
  });

  it('builds nothing from input without a session or with a relative cwd', () => {
    expect(buildHookEvent('stop', { cwd: '/x' })).toBeNull();
    expect(buildHookEvent('stop', { session_id: 's', cwd: 'rel' })).toBeNull();
    expect(
      buildHookEvent('post-tool-use', {
        session_id: 's',
        cwd: '/x',
        tool_name: 'Bash',
      }),
    ).toBeNull();
  });

  it('cuts raw content to the given cap and marks it', () => {
    const event = buildHookEvent(
      'user-prompt-submit',
      { session_id: 's', cwd: '/x', prompt: 'abcdef' },
      {},
      3,
    );
    expect(event?.content).toEqual({
      content: { text: 'abc', truncated: true },
    });
    expect(event?.data).toEqual({ chars: 6 });
  });
});

describe('PermissionRequest output (spec 201 D17)', () => {
  // Pinned against "PermissionRequest decision control",
  // https://code.claude.com/docs/en/hooks, read 2026-10-14.
  const pinned = fixture('permission-request-output') as {
    allow: unknown;
    deny: unknown;
  };

  it('prints the documented allow shape', () => {
    const decision: PermissionDecision = { behavior: 'allow' };
    expect(JSON.parse(permissionOutput(decision))).toEqual(pinned.allow);
  });

  it('prints the documented deny shape with the message', () => {
    const decision: PermissionDecision = {
      behavior: 'deny',
      message: 'Not on prod, please.',
    };
    expect(JSON.parse(permissionOutput(decision))).toEqual(pinned.deny);
    expect(DEFAULT_DENY_MESSAGE.length).toBeGreaterThan(0);
  });
});

describe('ancestors (spec 201 D10)', () => {
  it('parses /proc/<pid>/stat, comm with spaces and parens included', () => {
    expect(parseProcStat('123 (claude) S 100 123 123 0 -1')).toEqual({
      comm: 'claude',
      ppid: 100,
    });
    expect(parseProcStat('9 (a (b) c) R 4 9 9')).toEqual({
      comm: 'a (b) c',
      ppid: 4,
    });
    expect(parseProcStat('garbage')).toBeNull();
  });

  it('walks /proc up from the parent, nearest first, stopping at init', async () => {
    const stat: Record<number, string> = {
      300: '300 (sh) S 200 0 0',
      200: '200 (claude) S 100 0 0',
      100: '100 (zsh) S 1 0 0',
    };
    const ancestors = await readAncestors(300, {
      os: 'linux',
      exec: async () => null,
      readFile: (path) => {
        const pid = Number(path.split('/')[2]);
        const text = stat[pid];
        if (!text) throw new Error('ENOENT');
        return text;
      },
    });
    expect(ancestors).toEqual([
      { pid: 300, comm: 'sh' },
      { pid: 200, comm: 'claude' },
      { pid: 100, comm: 'zsh' },
    ]);
  });

  it('walks with ps on macOS', async () => {
    const table: Record<string, string> = {
      '50': '   40 /bin/sh\n',
      '40': '   30 /Users/p/.local/bin/claude\n',
      '30': '    1 -zsh\n',
    };
    const ancestors = await readAncestors(50, {
      os: 'darwin',
      exec: async (_bin, args) => {
        const out = table[args[args.length - 1] ?? ''];
        return out ? { code: 0, stdout: out, stderr: '' } : null;
      },
    });
    expect(ancestors.map((a) => a.pid)).toEqual([50, 40, 30]);
    expect(ancestors[1]?.comm).toBe('/Users/p/.local/bin/claude');
  });
});
