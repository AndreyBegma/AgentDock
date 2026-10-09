import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import type {
  TerminalAttachArgs,
  TerminalCloseReason,
} from '@agentdock/shared/protocol';
import { systemClock } from '../clock';
import { createExec, type Exec } from '../detect/exec';
import { memoryLogger } from '../testing/fixtures';
import { workspace } from '../testing/projects';
import { TerminalManager, type TerminalOutbound } from './manager';
import { bunSpawnPty, type PtyProcess } from './pty';

/**
 * Spec 29's attach criteria against a real tmux, through Bun's real PTY. The
 * server is private (`tmux -L <name>`): the user's own server — where live
 * fleets run — is never listed, attached to or touched.
 */
const tmuxInstalled = Bun.which('tmux') !== null;

let ws: ReturnType<typeof workspace> | undefined;
let killServer: (() => Promise<unknown>) | undefined;
const managers: TerminalManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) m.stop();
  await killServer?.();
  ws?.cleanup();
});

const eventually = async (
  check: () => boolean | Promise<boolean>,
  ms = 5000,
) => {
  for (let i = 0; i < ms / 25; i++) {
    if (await check()) return true;
    await Bun.sleep(25);
  }
  return check();
};

const exitsWithin = (proc: PtyProcess | undefined, ms: number) =>
  Promise.race([
    proc?.exited.then(() => true) ?? Promise.resolve(false),
    Bun.sleep(ms).then(() => false),
  ]);

const fixture = async () => {
  ws = workspace();
  const root = await ws.repo('widget', 'git@github.com:acme/widget.git');
  await ws.commit('widget');
  const worktree = join(ws.ws, '.wt-widget-i42');
  await ws.run(root, 'worktree', 'add', '-q', '-b', 'feat/i42', worktree);

  const server = ['-L', `agentdock-test-${process.pid}-${Date.now()}`];
  const env = { PATH: process.env.PATH, HOME: ws.ws };
  const tmuxExec = createExec(env);
  killServer = () => tmuxExec('tmux', [...server, 'kill-server']);
  const exec: Exec = (bin, args) =>
    bin === 'git' ? ws!.git(bin, args) : tmuxExec(bin, args);
  const tmux = (...args: string[]) => tmuxExec('tmux', [...server, ...args]);

  const created = await tmux(
    'new-session',
    '-d',
    '-s',
    'cs-i42',
    '-x',
    '100',
    '-y',
    '30',
    '-c',
    worktree,
    'cat',
  );
  expect(created?.code).toBe(0);

  const procs: PtyProcess[] = [];
  const sent: TerminalOutbound[] = [];
  const spawn = bunSpawnPty(env);
  const manager = (
    limits: { idleTimeoutMs?: number; maxDurationMs?: number } = {},
  ) => {
    const m = new TerminalManager({
      exec,
      clock: systemClock,
      log: memoryLogger().log,
      watchedProjects: () => [{ id: 'prj_1', root }],
      send: (message) => {
        sent.push(message);
        return true;
      },
      spawn: (options) => {
        const proc = spawn(options);
        procs.push(proc);
        return proc;
      },
      tmuxServer: server,
      ...limits,
    });
    managers.push(m);
    return m;
  };
  const args = (
    id: string,
    mode: TerminalAttachArgs['mode'],
  ): TerminalAttachArgs => ({
    id,
    target: { kind: 'slot', projectId: 'prj_1', root, slot: 'i42' },
    mode,
    cols: 100,
    rows: 30,
  });
  const pane = async () =>
    (await tmux('capture-pane', '-p', '-t', '=cs-i42:'))?.stdout ?? '';
  const alive = async () =>
    (await tmux('has-session', '-t', '=cs-i42'))?.code === 0;
  const clients = async () =>
    ((await tmux('list-clients', '-t', '=cs-i42'))?.stdout ?? '').trim();
  const type = (m: TerminalManager, id: string, text: string) =>
    m.data({
      type: 'terminal.data',
      id,
      b64: Buffer.from(text).toString('base64'),
    });
  const closedWith = (id: string): TerminalCloseReason | null => {
    const close = sent.find((s) => s.type === 'terminal.close' && s.id === id);
    return close?.type === 'terminal.close' ? close.reason : null;
  };
  return { manager, args, procs, sent, pane, alive, clients, type, closedWith };
};

describe.skipIf(!tmuxInstalled)(
  'terminal attach on a real tmux and PTY',
  () => {
    it('read streams the pane and drops input; write types; every close leaves the session running', async () => {
      const f = await fixture();
      const m = f.manager();

      // Read-only: the pane streams, typed characters never reach the session.
      expect(await m.attach(f.args('r1', 'read'))).toEqual({
        attached: true,
        session: 'cs-i42',
      });
      expect(
        await eventually(() => f.sent.some((s) => s.type === 'terminal.data')),
      ).toBe(true);
      expect(await eventually(async () => (await f.clients()).length > 0)).toBe(
        true,
      );
      f.type(m, 'r1', 'readonly-input-xyz\r');
      await Bun.sleep(300);
      expect(await f.pane()).not.toContain('readonly-input-xyz');

      m.close({ type: 'terminal.close', id: 'r1', reason: 'client' });
      expect(await exitsWithin(f.procs[0], 5000)).toBe(true);
      expect(await f.alive()).toBe(true);

      // Take control: a second, read-write attach; the typed command appears.
      await m.attach(f.args('w1', 'write'));
      f.type(m, 'w1', 'typed-by-admin\r');
      expect(
        await eventually(async () =>
          (await f.pane()).includes('typed-by-admin'),
        ),
      ).toBe(true);

      // The runner socket drops: the client ends, the session stays.
      m.reset();
      expect(await exitsWithin(f.procs[1], 5000)).toBe(true);
      expect(await f.alive()).toBe(true);
      expect(await eventually(async () => (await f.clients()) === '')).toBe(
        true,
      );
    });

    it('closes with idle and with max_duration, and the session survives both', async () => {
      const f = await fixture();

      const idle = f.manager({ idleTimeoutMs: 300 });
      await idle.attach(f.args('i1', 'write'));
      expect(await eventually(() => f.closedWith('i1') === 'idle')).toBe(true);
      expect(await exitsWithin(f.procs[0], 5000)).toBe(true);
      expect(await f.alive()).toBe(true);

      const max = f.manager({ maxDurationMs: 300 });
      await max.attach(f.args('m1', 'read'));
      expect(
        await eventually(() => f.closedWith('m1') === 'max_duration'),
      ).toBe(true);
      expect(await exitsWithin(f.procs[1], 5000)).toBe(true);
      expect(await f.alive()).toBe(true);
    });
  },
);
