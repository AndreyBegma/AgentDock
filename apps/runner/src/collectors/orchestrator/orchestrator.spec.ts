import { describe, expect, it } from 'bun:test';
import type { ExecResult } from '../../detect/exec';
import { brief, fleetFixture } from '../../fleet/testing';
import type { TmuxPane } from '../tmux/tmux';
import { OrchestratorWatcher, parseProcessTable } from './orchestrator';

const pane = (overrides: Partial<TmuxPane>): TmuxPane => ({
  session: 'agentdock-orchestrator',
  paneId: '%1',
  active: true,
  path: '/srv/widget',
  pid: 100,
  startCommand: '',
  ...overrides,
});

const BUSY = '✻ Thinking… (esc to interrupt)';

const setup = (ps?: string) => {
  const f = fleetFixture();
  const screens = new Map<string, string>();
  const watcher = new OrchestratorWatcher({
    ...f,
    exec: async (binary): Promise<ExecResult | null> =>
      binary === 'ps' && ps !== undefined
        ? { code: 0, stdout: ps, stderr: '' }
        : null,
    capture: async (id) => screens.get(id) ?? null,
  });
  return { ...f, watcher, screens };
};

describe('OrchestratorWatcher', () => {
  it('is running while agentdock-orchestrator runs in the root, absent after it exits', async () => {
    const { watcher, events, screens } = setup();
    screens.set('%1', BUSY);
    await watcher.poll([pane({})]);
    await watcher.poll([pane({})]);
    await watcher.poll([]);
    await watcher.poll([]);
    expect(brief(events.take())).toEqual([
      {
        type: 'orchestrator.started',
        data: { session: 'agentdock-orchestrator' },
      },
      { type: 'pane.busy', data: { target: 'orchestrator' } },
      {
        type: 'orchestrator.stopped',
        data: { session: 'agentdock-orchestrator', reason: 'session gone' },
      },
    ]);
  });

  it('reports absent on the first poll when nothing runs', async () => {
    const { watcher, events } = setup();
    await watcher.poll([pane({ path: '/srv/other' })]);
    expect(brief(events.take())).toEqual([
      {
        type: 'orchestrator.stopped',
        data: { session: 'agentdock-orchestrator', reason: 'not running' },
      },
    ]);
  });

  it('reports the orchestrator pane going idle', async () => {
    const { watcher, events, screens } = setup();
    screens.set('%1', '> ');
    for (let i = 0; i < 3; i++) await watcher.poll([pane({})]);
    expect(events.take().map((e) => e.type)).toEqual([
      'orchestrator.started',
      'pane.idle',
    ]);
  });

  it('finds the skill in a start command or the process tree, inside the root only', async () => {
    const started = setup();
    await started.watcher.poll([
      pane({
        session: 'work',
        path: '/srv/widget/apps',
        startCommand: "claude '/code-sentinel:orchestrator'",
      }),
    ]);
    expect(started.events.take()[0]).toMatchObject({
      type: 'orchestrator.started',
      data: { session: 'work' },
    });

    const tree = setup(
      [
        '  100     1 -zsh',
        '  200   100 claude --model opus /code-sentinel:orchestrator',
        '  300     1 claude /code-sentinel:orchestrator',
      ].join('\n'),
    );
    await tree.watcher.poll([pane({ session: 'work', pid: 100 })]);
    expect(tree.events.take()[0]).toMatchObject({
      type: 'orchestrator.started',
      data: { session: 'work' },
    });

    const elsewhere = setup();
    await elsewhere.watcher.poll([
      pane({ path: '/srv/widget-2' }),
      pane({ session: 'cs-i42', startCommand: 'code-sentinel:orchestrator' }),
    ]);
    expect(elsewhere.events.take().map((e) => e.type)).toEqual([
      'orchestrator.stopped',
    ]);
  });

  it('reports a move to another session as stopped then started', async () => {
    const { watcher, events } = setup();
    await watcher.poll([pane({})]);
    await watcher.poll([
      pane({ session: 'work', startCommand: 'code-sentinel:orchestrator' }),
    ]);
    expect(events.take().map((e) => [e.type, e.data])).toEqual([
      ['orchestrator.started', { session: 'agentdock-orchestrator' }],
      [
        'orchestrator.stopped',
        { session: 'agentdock-orchestrator', reason: 'moved to work' },
      ],
      ['orchestrator.started', { session: 'work' }],
    ]);
  });
});

describe('parseProcessTable', () => {
  it('reads pid, ppid and args', () => {
    expect([...parseProcessTable('  1 0 init\n 42  1 a b c\n')]).toEqual([
      [1, { ppid: 0, args: 'init' }],
      [42, { ppid: 1, args: 'a b c' }],
    ]);
  });
});
