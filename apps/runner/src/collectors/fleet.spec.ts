import { afterEach, describe, expect, it } from 'bun:test';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Exec, ExecResult } from '../detect/exec';
import { brief, recorder } from '../fleet/testing';
import { FakeClock } from '../testing/fake-clock';
import { memoryLogger } from '../testing/fixtures';
import { workspace } from '../testing/projects';
import { FleetCollector } from './fleet';
import { collectors } from './index';
import { DEFAULT_FLEET_SETTINGS } from './registry';
import { PANE_FIELD_SEP } from './tmux/tmux';

let ws: ReturnType<typeof workspace>;
afterEach(() => ws?.cleanup());

const BUSY = '✻ Working… (esc to interrupt)';

/**
 * A project `widget` with slot `i42`: a brief on today's board, its worktree
 * one commit ahead of `main`. tmux is a table the test rewrites; git is real.
 */
const fixture = async () => {
  ws = workspace();
  const root = await ws.repo('widget');
  await ws.commit('widget');
  const wt = join(ws.ws, '.wt-widget-i42');
  await ws.run(root, 'worktree', 'add', '-q', '-b', 'feat/42-x', wt);
  await ws.commit('.wt-widget-i42');
  // dispatch.sh excludes the channel files, so they never make a worktree dirty.
  appendFileSync(
    join(root, '.git', 'info', 'exclude'),
    '.orchestrator-reply.md\n.orchestrator-brief.md\n',
  );
  ws.files({
    'widget/.git/cs-orchestrator/2026-10-08/round-0923-i42.md': [
      '# Brief — i42',
      'Issue: #42 — https://github.com/acme/widget/issues/42',
      'Branch: feat/42-x',
      'Base: main',
      `Worktree: ${wt}`,
      'Model: sonnet — a sibling exists',
      '',
      '## What this slot owns, and what it must not open',
      'owns:',
      '  - src/**',
    ].join('\n'),
  });

  const tmux: { panes: string | null; screens: Record<string, string> } = {
    panes: '',
    screens: {},
  };
  const exec: Exec = async (binary, args): Promise<ExecResult | null> => {
    if (binary === 'git') return ws.git(binary, args);
    if (binary !== 'tmux') return null;
    if (args[0] === 'list-panes') {
      return tmux.panes === null
        ? null
        : { code: 0, stdout: tmux.panes, stderr: '' };
    }
    const screen = tmux.screens[args.at(-1) ?? ''];
    return screen === undefined
      ? { code: 1, stdout: '', stderr: "can't find pane" }
      : { code: 0, stdout: screen, stderr: '' };
  };
  const clock = new FakeClock(Date.parse('2026-10-08T10:00:00.000Z'));
  const events = recorder();
  const { log, lines } = memoryLogger();
  const collector = new FleetCollector(
    { exec, clock, log, fleet: DEFAULT_FLEET_SETTINGS },
    { watchFiles: false },
  );
  const start = async () => {
    await collector.start({ id: 'prj_1', root }, events.emit);
    await collector.settled();
  };
  return { root, wt, tmux, collector, events, start, clock, lines };
};

const pane = (session: string, id: string, path: string) =>
  `${[session, id, '1', '4242', path, ''].join(PANE_FIELD_SEP)}\n`;

describe('FleetCollector', () => {
  it('is registered once in the collector list', () => {
    const names = collectors.map(
      (create) =>
        create({
          exec: async () => null,
          clock: new FakeClock(),
          log: memoryLogger().log,
          fleet: DEFAULT_FLEET_SETTINGS,
        }).name,
    );
    expect(names.filter((name) => name === 'fleet')).toHaveLength(1);
  });

  it('reports a slot running, then stale with its unmerged commit after its session dies', async () => {
    const { wt, tmux, collector, events, start } = await fixture();
    tmux.panes = pane('cs-i42', '%3', wt) + pane('other', '%9', '/tmp');
    tmux.screens['%3'] = BUSY;
    await start();
    const first = events.take();
    expect(first.every((e) => e.project?.repo === 'widget')).toBe(true);
    expect(brief(first)).toEqual([
      {
        type: 'slot.dispatched',
        slot: 'i42',
        data: expect.objectContaining({
          round: '0923',
          model: 'sonnet',
          modelWhy: 'a sibling exists',
          owns: ['src/**'],
        }),
      },
      {
        type: 'worktree.changed',
        slot: 'i42',
        data: {
          path: wt,
          exists: true,
          branch: 'feat/42-x',
          ahead: 1,
          behind: 0,
          dirty: false,
        },
      },
      { type: 'session.appeared', slot: 'i42', data: { name: 'cs-i42' } },
      { type: 'pane.busy', slot: 'i42', data: { target: 'slot' } },
      {
        type: 'orchestrator.stopped',
        data: { session: 'agentdock-orchestrator', reason: 'not running' },
      },
    ]);
    expect(first.find((e) => e.type === 'slot.dispatched')?.issue).toBe(42);

    await collector.tick();
    expect(events.take()).toEqual([]);

    tmux.panes = '';
    await collector.tick();
    expect(brief(events.take())).toEqual([
      { type: 'session.vanished', slot: 'i42', data: { name: 'cs-i42' } },
    ]);
    collector.stop();
  });

  it('reads reply checkpoints once the worktree is known', async () => {
    const { wt, collector, events, start } = await fixture();
    writeFileSync(
      join(wt, '.orchestrator-reply.md'),
      '## picked up\ni42\n## plan ready\nplan\n',
    );
    await start();
    const checkpoints = events
      .take()
      .filter((e) => e.type === 'slot.checkpoint')
      .map((e) => e.data);
    expect(checkpoints).toEqual([
      expect.objectContaining({ checkpoint: 'picked_up', position: 0 }),
      expect.objectContaining({ checkpoint: 'plan_ready', position: 1 }),
    ]);
    collector.stop();
  });

  it('reports on the first poll a slot whose worker ran and whose session is gone', async () => {
    const { wt, collector, events, start } = await fixture();
    writeFileSync(join(wt, '.orchestrator-reply.md'), '## picked up\n');
    await start();
    expect(
      events
        .take()
        .filter((e) => e.type.startsWith('session.'))
        .map((e) => [e.type, e.slot]),
    ).toEqual([['session.vanished', 'i42']]);
    collector.stop();
  });

  it('ignores a session of another repository with the same slot name', async () => {
    const { wt, tmux, collector, events, start } = await fixture();
    tmux.panes = pane('cs-glass-ui--i42', '%3', wt) + pane('cs-i7', '%4', wt);
    await start();
    expect(events.take().some((e) => e.type.startsWith('session.'))).toBe(
      false,
    );
    tmux.panes = pane('cs-widget--i42', '%5', wt);
    await collector.tick();
    expect(brief(events.take())).toEqual([
      {
        type: 'session.appeared',
        slot: 'i42',
        data: { name: 'cs-widget--i42' },
      },
    ]);
    collector.stop();
  });

  it('reports a removed worktree as gone', async () => {
    const { root, wt, collector, events, start } = await fixture();
    await start();
    events.take();
    await ws.run(root, 'worktree', 'remove', '--force', wt);
    await collector.tick();
    expect(brief(events.take())).toEqual([
      {
        type: 'worktree.changed',
        slot: 'i42',
        data: { path: wt, exists: false },
      },
    ]);
    collector.stop();
  });

  it('keeps running without tmux, and says so once', async () => {
    const { tmux, collector, events, start, lines } = await fixture();
    tmux.panes = null;
    await start();
    await collector.tick();
    expect(events.take().map((e) => e.type)).toEqual([
      'slot.dispatched',
      'worktree.changed',
    ]);
    expect(lines.filter((l) => l.includes('tmux unavailable'))).toHaveLength(1);
    collector.stop();
  });

  it('polls on the configured intervals and stops cleanly', async () => {
    const { tmux, collector, events, start, clock } = await fixture();
    await start();
    events.take();
    expect(clock.pending()).toEqual([15_000, 60_000, 60_000]);
    tmux.panes = null;
    collector.stop();
    expect(clock.pending()).toEqual([]);
  });
});
