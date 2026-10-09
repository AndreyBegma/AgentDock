import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { systemClock } from '../clock';
import { createExec, type Exec } from '../detect/exec';
import { memoryLogger } from '../testing/fixtures';
import { workspace } from '../testing/projects';
import { type PaneOutbound, PaneStreamer } from './streamer';

/**
 * Spec 18's capture criteria against a real tmux. The server is private
 * (`tmux -L <name>`): the user's own server — where live fleets run — is
 * never listed, let alone touched.
 */
const tmuxInstalled = Bun.which('tmux') !== null;

let ws: ReturnType<typeof workspace> | undefined;
let killServer: (() => Promise<unknown>) | undefined;
let streamer: PaneStreamer | undefined;
afterEach(async () => {
  streamer?.stop();
  await killServer?.();
  ws?.cleanup();
});

const eventually = async (check: () => boolean, ms = 5000) => {
  for (let i = 0; i < ms / 25 && !check(); i++) await Bun.sleep(25);
  return check();
};

describe.skipIf(!tmuxInstalled)('pane streaming on a real tmux', () => {
  it('streams a counter as full then patches, shares one loop, ends with the session', async () => {
    ws = workspace();
    const root = await ws.repo('widget', 'git@github.com:acme/widget.git');
    await ws.commit('widget');
    await ws.run(
      root,
      'worktree',
      'add',
      '-q',
      '-b',
      'feat/i42',
      join(ws.ws, '.wt-widget-i42'),
    );

    const server = ['-L', `agentdock-test-${process.pid}-${Date.now()}`];
    const tmuxExec = createExec({ PATH: process.env.PATH, HOME: ws.ws });
    killServer = () => tmuxExec('tmux', [...server, 'kill-server']);
    let captures = 0;
    const exec: Exec = (bin, args) => {
      if (bin === 'tmux' && args.includes('capture-pane')) captures++;
      return bin === 'git' ? ws!.git(bin, args) : tmuxExec(bin, args);
    };

    const created = await tmuxExec('tmux', [
      ...server,
      'new-session',
      '-d',
      '-s',
      'cs-i42',
      '-c',
      join(ws.ws, '.wt-widget-i42'),
      'sh',
      '-c',
      'i=0; while [ $i -lt 40 ]; do echo "count $i"; i=$((i+1)); sleep 0.2; done; sleep 600',
    ]);
    expect(created?.code).toBe(0);

    const sent: PaneOutbound[] = [];
    streamer = new PaneStreamer({
      exec,
      clock: systemClock,
      watchedProjects: () => [{ id: 'prj_1', root }],
      send: (message) => {
        sent.push(message);
        return true;
      },
      log: memoryLogger().log,
      tmuxServer: server,
      intervalMs: 200,
    });
    const subscribe = (id: string) =>
      streamer?.subscribe({
        type: 'subscribe',
        id,
        kind: 'pane',
        projectId: 'prj_1',
        root,
        slot: 'i42',
      });
    const frames = (id: string) =>
      sent.flatMap((m) => (m.type === 'pane' && m.id === id ? [m.frame] : []));

    await subscribe('a');
    await subscribe('b');
    expect(streamer.loopCount).toBe(1);
    expect(await eventually(() => frames('a').length >= 3, 2000)).toBe(true);
    expect(frames('a')[0]?.type).toBe('full');
    expect(
      frames('a')
        .slice(1)
        .every((f) => f.type === 'patch'),
    ).toBe(true);
    expect(frames('b')[0]?.type).toBe('full');
    const first = frames('a')[0];
    if (first?.type !== 'full') throw new Error('expected full');
    expect(first.lines.some((l) => l.startsWith('count'))).toBe(true);

    // Two viewers, one loop: roughly one capture per tick, not two.
    const before = captures;
    await Bun.sleep(1000);
    expect(captures - before).toBeLessThanOrEqual(7);

    streamer.unsubscribe('a');
    streamer.unsubscribe('b');
    expect(streamer.loopCount).toBe(0);
    await Bun.sleep(100);
    const stopped = captures;
    await Bun.sleep(600);
    expect(captures).toBe(stopped);

    await subscribe('c');
    expect(await eventually(() => frames('c').length >= 1)).toBe(true);
    await tmuxExec('tmux', [...server, 'kill-session', '-t', '=cs-i42']);
    expect(await eventually(() => frames('c').at(-1)?.type === 'ended')).toBe(
      true,
    );
    expect(streamer.loopCount).toBe(0);
  }, 20_000);
});
