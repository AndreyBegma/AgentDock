import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { join } from 'node:path';
import { createExec, type Exec } from '../detect/exec';
import { brief, recorder } from '../fleet/testing';
import { FakeClock } from '../testing/fake-clock';
import { memoryLogger } from '../testing/fixtures';
import { REAL_PROCESS_TIMEOUT_MS, workspace } from '../testing/projects';
import { FleetCollector } from './fleet';
import { DEFAULT_FLEET_SETTINGS } from './registry';

setDefaultTimeout(REAL_PROCESS_TIMEOUT_MS);

/**
 * Spec 11's fixture-project criterion against a real tmux: a temp repo, its
 * `.wt-<repo>-i42` worktree one commit ahead, and a `cs-i42` session running
 * `sleep`. The server is private (`tmux -L <name>`) — the user's own tmux
 * server and its sessions are never listed, let alone touched.
 */
const tmuxInstalled = Bun.which('tmux') !== null;

let ws: ReturnType<typeof workspace> | undefined;
let killServer: (() => Promise<unknown>) | undefined;
afterEach(async () => {
  await killServer?.();
  ws?.cleanup();
});

describe.skipIf(!tmuxInstalled)('FleetCollector on a real tmux', () => {
  it('lists the slot running, and stale with its unmerged commit after the session is killed', async () => {
    ws = workspace();
    const root = await ws.repo('widget');
    await ws.commit('widget');
    const wt = join(ws.ws, '.wt-widget-i42');
    await ws.run(root, 'worktree', 'add', '-q', '-b', 'feat/42-x', wt);
    await ws.commit('.wt-widget-i42');

    const server = ['-L', `agentdock-test-${process.pid}-${Date.now()}`];
    const tmux = createExec({ PATH: process.env.PATH, HOME: ws.ws });
    const run = (...args: string[]) => tmux('tmux', [...server, ...args]);
    killServer = () => run('kill-server');
    const exec: Exec = (binary, args) =>
      binary === 'git'
        ? (ws as NonNullable<typeof ws>).git(binary, args)
        : tmux(binary, args);

    const created = await run(
      'new-session',
      '-d',
      '-s',
      'cs-i42',
      '-c',
      wt,
      'sleep',
      '600',
    );
    expect(created?.code).toBe(0);

    const events = recorder();
    const collector = new FleetCollector(
      {
        exec,
        clock: new FakeClock(),
        log: memoryLogger().log,
        fleet: DEFAULT_FLEET_SETTINGS,
      },
      { tmuxServer: server, watchFiles: false },
    );
    await collector.start({ id: 'prj_1', root }, events.emit);
    await collector.settled();
    const running = brief(events.take());
    expect(running).toContainEqual({
      type: 'session.appeared',
      slot: 'i42',
      data: { name: 'cs-i42' },
    });
    expect(running).toContainEqual({
      type: 'worktree.changed',
      slot: 'i42',
      data: expect.objectContaining({ exists: true, ahead: 1 }),
    });

    expect((await run('kill-session', '-t', 'cs-i42'))?.code).toBe(0);
    await collector.tick();
    expect(brief(events.take())).toEqual([
      { type: 'session.vanished', slot: 'i42', data: { name: 'cs-i42' } },
    ]);
    collector.stop();
  });
});
