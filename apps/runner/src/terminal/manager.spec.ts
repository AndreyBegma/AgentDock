import { describe, expect, it } from 'bun:test';
import {
  TERMINAL_MAX_DATA_BYTES,
  type TerminalAttachArgs,
  type TerminalTarget,
  terminalCloseMessageSchema,
  terminalDataMessageSchema,
} from '@agentdock/shared/protocol';
import { CommandFailure } from '../commands/failure';
import { fakeTmux } from '../control/testing';
import { FakeClock } from '../testing/fake-clock';
import { memoryLogger } from '../testing/fixtures';
import { TerminalManager, type TerminalOutbound } from './manager';
import type { PtyProcess, PtySpawnOptions } from './pty';

const root = '/srv/widget';
const slot = (name: string): TerminalTarget => ({
  kind: 'slot',
  projectId: 'prj_1',
  root,
  slot: name,
});

const args = (
  id: string,
  target: TerminalTarget = slot('i42'),
  mode: TerminalAttachArgs['mode'] = 'read',
): TerminalAttachArgs => ({ id, target, mode, cols: 120, rows: 40 });

interface FakePty extends PtyProcess {
  options: PtySpawnOptions;
  written: Uint8Array[];
  sizes: [number, number][];
  signals: string[];
  /** The `tmux attach` client exits on its own. */
  exit(): void;
}

const setup = (
  overrides: {
    sessions?: Record<string, string>;
    worktrees?: string[];
    maxAttaches?: number;
    unsupported?: string;
    spawnFails?: boolean;
  } = {},
) => {
  const fake = fakeTmux({
    worktrees: overrides.worktrees ?? [
      '/srv/.wt-widget-i42',
      '/srv/.wt-widget-i7',
    ],
    sessions: overrides.sessions ?? {
      'cs-i42': '',
      'cs-i7': '',
      'agentdock-orch-acme-widget': '',
    },
  });
  const clock = new FakeClock();
  const { log, lines } = memoryLogger();
  const sent: TerminalOutbound[] = [];
  const ptys: FakePty[] = [];
  const manager = new TerminalManager({
    exec: fake.deps.exec,
    clock,
    log,
    watchedProjects: fake.deps.watchedProjects,
    send: (message) => {
      sent.push(message);
      return true;
    },
    spawn: (options) => {
      if (overrides.spawnFails) throw new Error('no pty');
      let exit = () => {};
      const pty: FakePty = {
        options,
        written: [],
        sizes: [],
        signals: [],
        write: (bytes) => pty.written.push(bytes),
        resize: (cols, rows) => pty.sizes.push([cols, rows]),
        kill: (signal) => pty.signals.push(signal),
        exited: new Promise<void>((resolve) => {
          exit = resolve;
        }),
        close: () => {},
        exit: () => exit(),
      };
      ptys.push(pty);
      return pty;
    },
    unsupported: overrides.unsupported
      ? async () => overrides.unsupported ?? null
      : undefined,
    maxAttaches: overrides.maxAttaches,
    idleTimeoutMs: 60_000,
    maxDurationMs: 600_000,
    killGraceMs: 2_000,
  });
  const refusal = async (attach: Promise<unknown>) => {
    try {
      await attach;
    } catch (error) {
      if (error instanceof CommandFailure) return error.code;
      throw error;
    }
    throw new Error('the attach was not refused');
  };
  const b64 = (text: string) => Buffer.from(text).toString('base64');
  return { fake, clock, lines, sent, ptys, manager, refusal, b64 };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('terminal.attach — spawn', () => {
  it('spawns a read-only, ignore-size client on an exact target', async () => {
    const { manager, ptys } = setup();
    expect(await manager.attach(args('t1'))).toEqual({
      attached: true,
      session: 'cs-i42',
    });
    expect(ptys[0]?.options.argv).toEqual([
      'tmux',
      'attach-session',
      '-r',
      '-f',
      'ignore-size',
      '-t',
      '=cs-i42',
    ]);
    expect(ptys[0]?.options.cols).toBe(120);
    expect(ptys[0]?.options.rows).toBe(40);
  });

  it('spawns the plain attach-session for write', async () => {
    const { manager, ptys } = setup();
    await manager.attach(args('t1', slot('i42'), 'write'));
    expect(ptys[0]?.options.argv).toEqual([
      'tmux',
      'attach-session',
      '-t',
      '=cs-i42',
    ]);
  });

  it('attaches to the orchestrator session of the project', async () => {
    const { manager, ptys } = setup();
    expect(
      await manager.attach(
        args('t1', { kind: 'orchestrator', projectId: 'prj_1', root }),
      ),
    ).toEqual({ attached: true, session: 'agentdock-orch-acme-widget' });
    expect(ptys[0]?.options.argv.at(-1)).toBe('=agentdock-orch-acme-widget');
  });

  it('picks the sorted-first session when both slot names are live', async () => {
    const { manager } = setup({
      sessions: { 'cs-widget--i42': '', 'cs-i42': '' },
    });
    expect((await manager.attach(args('t1'))).session).toBe('cs-i42');
  });

  it('answers internal, not a success, when the client cannot spawn', async () => {
    const { manager } = setup({ spawnFails: true });
    await expect(manager.attach(args('t1'))).rejects.toThrow(
      'cannot attach to cs-i42',
    );
    expect(manager.attachCount).toBe(0);
  });
});

describe('terminal.attach — target refusals (D2)', () => {
  it('refuses a slot whose worktree belongs to another project', async () => {
    // cs-i9 is live, but .wt-other-i9 is not a worktree of /srv/widget.
    const { manager, refusal, ptys } = setup({
      worktrees: ['/srv/.wt-widget-i42', '/srv/.wt-other-i9'],
      sessions: { 'cs-i42': '', 'cs-i9': '' },
    });
    expect(await refusal(manager.attach(args('t1', slot('i9'))))).toBe(
      'not_found',
    );
    expect(ptys).toHaveLength(0);
  });

  it('refuses an unknown slot, and a slot with no live session', async () => {
    const { manager, refusal } = setup({ sessions: { 'cs-i42': '' } });
    expect(await refusal(manager.attach(args('t1', slot('i99'))))).toBe(
      'not_found',
    );
    expect(await refusal(manager.attach(args('t2', slot('i7'))))).toBe(
      'not_found',
    );
  });

  it('refuses a project that is not watched under that id', async () => {
    const { manager, refusal } = setup();
    expect(
      await refusal(
        manager.attach(args('t1', { ...slot('i42'), projectId: 'prj_other' })),
      ),
    ).toBe('not_found');
    expect(
      await refusal(
        manager.attach(args('t2', { ...slot('i42'), root: '/srv/other' })),
      ),
    ).toBe('not_found');
  });

  it('refuses an orchestrator that is not running', async () => {
    const { manager, refusal } = setup({ sessions: { 'cs-i42': '' } });
    expect(
      await refusal(
        manager.attach(
          args('t1', { kind: 'orchestrator', projectId: 'prj_1', root }),
        ),
      ),
    ).toBe('not_found');
  });

  it('answers unsupported for a skill run until #24 lands', async () => {
    const { manager, refusal } = setup();
    expect(
      await refusal(
        manager.attach(
          args('t1', {
            kind: 'skill_run',
            projectId: 'prj_1',
            root,
            runId: 'r1',
          }),
        ),
      ),
    ).toBe('unsupported');
  });

  it('answers unsupported when the machine cannot attach', async () => {
    const { manager, refusal, ptys } = setup({ unsupported: 'tmux 3.1' });
    expect(await refusal(manager.attach(args('t1')))).toBe('unsupported');
    expect(ptys).toHaveLength(0);
  });
});

describe('terminal.attach — limits (D7)', () => {
  it('refuses a third attach on the runner with busy', async () => {
    const { manager, refusal } = setup();
    await manager.attach(args('t1'));
    await manager.attach(args('t2', slot('i7')));
    expect(await refusal(manager.attach(args('t3')))).toBe('busy');
  });

  it('counts an attach still resolving against the cap', async () => {
    const { manager, refusal } = setup({ maxAttaches: 1 });
    const first = manager.attach(args('t1'));
    expect(await refusal(manager.attach(args('t2', slot('i7'))))).toBe('busy');
    await first;
  });

  it('allows one write per target, and reads beside it', async () => {
    const { manager, refusal } = setup({ maxAttaches: 4 });
    await manager.attach(args('t1', slot('i42'), 'write'));
    expect(
      await refusal(manager.attach(args('t2', slot('i42'), 'write'))),
    ).toBe('busy');
    await manager.attach(args('t3', slot('i42'), 'read'));
    await manager.attach(args('t4', slot('i7'), 'write'));
    expect(manager.attachCount).toBe(3);
  });

  it('refuses a stream id that is already attached', async () => {
    const { manager, refusal } = setup();
    await manager.attach(args('t1'));
    expect(await refusal(manager.attach(args('t1', slot('i7'))))).toBe('busy');
  });

  it('closes a write attach with idle when no input arrives; output does not count', async () => {
    const { manager, clock, sent, ptys, b64 } = setup();
    await manager.attach(args('t1', slot('i42'), 'write'));
    clock.advance(30_000);
    manager.data({ type: 'terminal.data', id: 't1', b64: b64('x') });
    clock.advance(50_000);
    ptys[0]?.options.onData(Buffer.from('output'));
    expect(manager.attachCount).toBe(1);
    clock.advance(10_000);
    expect(sent.at(-1)).toEqual({
      type: 'terminal.close',
      id: 't1',
      reason: 'idle',
    });
    expect(ptys[0]?.signals).toEqual(['SIGHUP']);
    expect(manager.attachCount).toBe(0);
  });

  it('keeps a read attach alive while output flows', async () => {
    const { manager, clock, ptys } = setup();
    await manager.attach(args('t1'));
    for (let i = 0; i < 5; i++) {
      clock.advance(40_000);
      ptys[0]?.options.onData(Buffer.from('tick'));
    }
    expect(manager.attachCount).toBe(1);
    clock.advance(60_000);
    expect(manager.attachCount).toBe(0);
  });

  it('closes with max_duration whatever the traffic', async () => {
    const { manager, clock, sent, b64 } = setup();
    await manager.attach(args('t1', slot('i42'), 'write'));
    for (let i = 0; i < 20; i++) {
      clock.advance(30_000);
      manager.data({ type: 'terminal.data', id: 't1', b64: b64('k') });
    }
    expect(sent.at(-1)).toEqual({
      type: 'terminal.close',
      id: 't1',
      reason: 'max_duration',
    });
  });
});

describe('terminal streams', () => {
  it('drops every input byte on a read attach (D4)', async () => {
    const { manager, ptys, lines, b64 } = setup();
    await manager.attach(args('t1'));
    manager.data({ type: 'terminal.data', id: 't1', b64: b64('rm -rf /\r') });
    expect(ptys[0]?.written).toEqual([]);
    manager.close({ type: 'terminal.close', id: 't1', reason: 'client' });
    const detached = lines.find((l) => l.includes('terminal: detached'));
    expect(detached).toContain('"bytesDropped":9');
    expect(detached).toContain('"bytesIn":0');
  });

  it('writes input on a write attach and resizes the PTY', async () => {
    const { manager, ptys, b64 } = setup();
    await manager.attach(args('t1', slot('i42'), 'write'));
    manager.data({ type: 'terminal.data', id: 't1', b64: b64('ls\r') });
    manager.resize({ type: 'terminal.resize', id: 't1', cols: 200, rows: 50 });
    expect(ptys[0]?.written.map((b) => Buffer.from(b).toString())).toEqual([
      'ls\r',
    ]);
    expect(ptys[0]?.sizes).toEqual([[200, 50]]);
  });

  it('ignores messages for an unknown stream id', async () => {
    const { manager, ptys, b64 } = setup();
    await manager.attach(args('t1', slot('i42'), 'write'));
    manager.data({ type: 'terminal.data', id: 'nope', b64: b64('x') });
    manager.close({ type: 'terminal.close', id: 'nope', reason: 'client' });
    expect(ptys[0]?.written).toEqual([]);
    expect(manager.attachCount).toBe(1);
  });

  it('streams output as valid terminal.data, split at 64 KiB', async () => {
    const { manager, ptys, sent } = setup();
    await manager.attach(args('t1'));
    ptys[0]?.options.onData(new Uint8Array(TERMINAL_MAX_DATA_BYTES * 2 + 5));
    const data = sent.filter((m) => m.type === 'terminal.data');
    expect(data).toHaveLength(3);
    for (const m of data) terminalDataMessageSchema.parse(m);
    const sizes = data.map((m) =>
      m.type === 'terminal.data' ? Buffer.from(m.b64, 'base64').length : 0,
    );
    expect(sizes).toEqual([
      TERMINAL_MAX_DATA_BYTES,
      TERMINAL_MAX_DATA_BYTES,
      5,
    ]);
  });

  it('a server close signals the client only, sends nothing back, and SIGKILLs a stuck one', async () => {
    const { manager, ptys, sent, clock, fake } = setup();
    await manager.attach(args('t1'));
    manager.close({ type: 'terminal.close', id: 't1', reason: 'client' });
    expect(sent).toEqual([]);
    expect(ptys[0]?.signals).toEqual(['SIGHUP']);
    clock.advance(2_000);
    expect(ptys[0]?.signals).toEqual(['SIGHUP', 'SIGKILL']);
    // No terminal path kills a session.
    expect(fake.tmuxCalls().some((c) => c[0] === 'kill-session')).toBe(false);
    expect(fake.sessions.has('cs-i42')).toBe(true);
  });

  it('no SIGKILL once the client exited after SIGHUP', async () => {
    const { manager, ptys, clock } = setup();
    await manager.attach(args('t1'));
    manager.close({ type: 'terminal.close', id: 't1', reason: 'client' });
    ptys[0]?.exit();
    await flush();
    clock.advance(5_000);
    expect(ptys[0]?.signals).toEqual(['SIGHUP']);
  });

  it('reports session_ended when the client exits on its own', async () => {
    const { manager, ptys, sent } = setup();
    await manager.attach(args('t1'));
    ptys[0]?.exit();
    await flush();
    expect(sent).toEqual([
      { type: 'terminal.close', id: 't1', reason: 'session_ended' },
    ]);
    terminalCloseMessageSchema.parse(sent[0]);
    expect(ptys[0]?.signals).toEqual([]);
    expect(manager.attachCount).toBe(0);
  });

  it('reset ends every attach without sending, and frees the slots', async () => {
    const { manager, ptys, sent } = setup();
    await manager.attach(args('t1'));
    await manager.attach(args('t2', slot('i7'), 'write'));
    manager.reset();
    expect(sent).toEqual([]);
    expect(ptys.map((p) => p.signals)).toEqual([['SIGHUP'], ['SIGHUP']]);
    expect(manager.attachCount).toBe(0);
    await manager.attach(args('t3'));
  });

  it('a close while resolving cancels the attach before any spawn', async () => {
    const { manager, ptys } = setup();
    const attach = manager.attach(args('t1'));
    manager.close({ type: 'terminal.close', id: 't1', reason: 'client' });
    await expect(attach).rejects.toThrow('closed while attaching');
    expect(ptys).toHaveLength(0);
  });

  it('logs byte counts, never bytes (D8)', async () => {
    const { manager, ptys, lines, b64 } = setup();
    await manager.attach(args('t1', slot('i42'), 'write'));
    manager.data({ type: 'terminal.data', id: 't1', b64: b64('SECRET-IN') });
    ptys[0]?.options.onData(Buffer.from('SECRET-OUT'));
    manager.close({ type: 'terminal.close', id: 't1', reason: 'client' });
    const all = lines.join('\n');
    expect(all).not.toContain('SECRET');
    expect(all).not.toContain(b64('SECRET-IN'));
    expect(all).not.toContain(Buffer.from('SECRET-OUT').toString('base64'));
    const detached = lines.find((l) => l.includes('terminal: detached'));
    expect(detached).toContain('"bytesIn":9');
    expect(detached).toContain('"bytesOut":10');
    expect(detached).toContain('"reason":"client"');
    expect(detached).toContain('"durationMs"');
  });
});
