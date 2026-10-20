import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  STEWARD_OBSERVED_EVENT,
  type StewardObservedData,
  type StewardRunnerConfig,
} from '@nautelle/shared';
import type {
  UnsequencedEvent,
  WatchedProject,
} from '@nautelle/shared/protocol';
import type { CardRecord } from '../cards/record';
import type { ConfigProfile } from '../config';
import { FakeClock } from '../testing/fake-clock';
import { memoryLogger } from '../testing/fixtures';
import { StewardObserver, type StewardRun } from './observer';

const START = Date.parse('2026-10-16T12:00:00.000Z');
const MIN = 60_000;
const SESSION = '3bb1739e-1a1c-4baa-b8b4-a4b1e6700361';
const CLASSIFIER_SESSION = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';

const PROMPT = [
  '╭──────────────────────────────────────────────╮',
  '│ >                                            │',
  '╰──────────────────────────────────────────────╯',
].join('\n');
const IDLE = `● Done with the step.\n\n${PROMPT}\n`;
const API_ERROR = `● Running the checks.\n  ⎿  API Error: Connection lost mid-response\n\n${PROMPT}\n`;
const BUSY = `● Bash(until ! pgrep -f jest; do sleep 5; done)\n✻ Waiting… (7m · esc to interrupt)\n\n${PROMPT}\n`;

const steward: StewardRunnerConfig = {
  enabled: true,
  silenceMinutes: 10,
  trailerGuard: true,
};

const record = (overrides: Partial<CardRecord> = {}): CardRecord => ({
  cardId: 'card_1',
  projectId: 'prj_widget',
  root: '/home/dev/widget',
  repo: 'widget',
  shortId: 'ab12cd34',
  worktree: '/home/dev/.wt-widget-card-ab12cd34',
  branch: 'card/c12-export-csv',
  base: 'main',
  tmuxSession: 'nautelle-card-ab12cd34',
  runId: 'run_1',
  phase: 'running',
  sessionId: SESSION,
  profileKey: 'claude-work',
  startedAt: new Date(START).toISOString(),
  ...overrides,
});

const profiles: ConfigProfile[] = [
  { id: 'claude-work', runtime: 'claude', env: {}, args: [] },
];

const setup = (
  options: {
    project?: Partial<WatchedProject>;
    classify?: () => Promise<{ reason: string; sessionId: string } | null>;
    runs?: StewardRun[];
    mtime?: number | null;
  } = {},
) => {
  const clock = new FakeClock(START);
  const events: UnsequencedEvent[] = [];
  const records = [record()];
  const panes = new Map<string, string | null>([
    ['nautelle-card-ab12cd34', IDLE],
  ]);
  const project: WatchedProject = {
    id: 'prj_widget',
    root: '/home/dev/widget',
    steward,
    ...options.project,
  };
  const classified: string[] = [];
  const observer = new StewardObserver({
    cards: {
      records: () => records,
      capture: async (session) => panes.get(session) ?? null,
    },
    runs: { running: () => options.runs ?? [] },
    watchedProjects: () => [project],
    profiles: () => profiles,
    classifier: {
      classify: async (_profile, _projectId, tail) => {
        classified.push(tail);
        if (options.classify) return options.classify();
        return {
          reason: 'a wait loop polls pgrep -f and matches itself',
          sessionId: CLASSIFIER_SESSION,
        };
      },
    },
    emit: (event) => events.push(event),
    clock,
    log: memoryLogger().log,
    mtime: () => options.mtime ?? null,
  });
  const observed = () =>
    events
      .filter((e) => e.type === STEWARD_OBSERVED_EVENT)
      .map((e) => e.data as StewardObservedData);
  const setPane = (text: string | null) =>
    panes.set('nautelle-card-ab12cd34', text);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    clock,
    events,
    records,
    observer,
    observed,
    setPane,
    classified,
    settle,
  };
};

describe('StewardObserver — pane signals (#447 D6, D9)', () => {
  it('observes an API error within one poll, once, and again after the pane recovered', async () => {
    const t = setup();
    t.setPane(API_ERROR);
    await t.observer.poll();
    await t.observer.poll();
    expect(t.observed()).toHaveLength(1);
    expect(t.observed()[0]).toMatchObject({
      projectId: 'prj_widget',
      subject: { kind: 'card_round', cardId: 'card_1', runId: 'run_1' },
      kind: 'api_error',
      reason: 'API error: the connection was lost mid-response',
    });
    // The nudge took: the pane works, then fails the same way again.
    t.setPane(BUSY);
    await t.observer.poll();
    t.setPane(API_ERROR);
    await t.observer.poll();
    expect(t.observed().map((o) => o.kind)).toEqual(['api_error', 'api_error']);
    // The envelope is the card's project.
    expect(t.events[0]?.project).toEqual({
      repo: 'widget',
      root: '/home/dev/widget',
    });
    expect(t.events[0]?.source).toBe('runner');
  });

  it('a rule match never calls the classifier', async () => {
    const t = setup();
    t.setPane(API_ERROR);
    t.clock.advance(30 * MIN);
    await t.observer.poll();
    await t.settle();
    expect(t.classified).toEqual([]);
    expect(t.observed().map((o) => o.kind)).toEqual(['api_error']);
  });

  it('a listed dialog carries its dialogId; a permission prompt is reported, not more', async () => {
    const t = setup();
    t.setPane(
      [
        '╭────────────────────────────────────────────╮',
        '│ Teach auto mode about your environment?    │',
        '│ ❯ 1. Yes                                   │',
        '│   2. Not now                               │',
        "│   3. Don't show again                      │",
        '╰────────────────────────────────────────────╯',
      ].join('\n'),
    );
    await t.observer.poll();
    t.setPane('Do you want to proceed?\n ❯ 1. Yes\n   2. No\n');
    await t.observer.poll();
    expect(t.observed().map((o) => [o.kind, o.dialogId])).toEqual([
      ['dialog', 'teach-auto-mode'],
      ['permission_prompt', undefined],
    ]);
  });
});

describe('StewardObserver — silence (#447 D3, D6)', () => {
  it('an idle round with no hook event past the threshold opens a silent incident, by rule', async () => {
    const t = setup();
    t.clock.advance(9 * MIN);
    await t.observer.poll();
    expect(t.observed()).toEqual([]);
    t.clock.advance(1 * MIN);
    await t.observer.poll();
    await t.observer.poll();
    expect(t.observed()).toHaveLength(1);
    expect(t.observed()[0]).toMatchObject({
      kind: 'silent',
      reason: 'waiting at the prompt, no activity for 10+ min',
    });
    expect(t.classified).toEqual([]);
  });

  it('a hook event restarts the clock', async () => {
    const t = setup();
    t.clock.advance(8 * MIN);
    t.observer.hookSeen({
      type: 'hook.tool_finished',
      session: { runtime: 'claude', id: SESSION },
      data: {},
    });
    t.clock.advance(8 * MIN);
    await t.observer.poll();
    expect(t.observed()).toEqual([]);
  });

  it('a round with a live background task never opens a silent incident (#390)', async () => {
    const t = setup();
    t.observer.hookSeen({
      type: 'hook.stopped',
      session: { runtime: 'claude', id: SESSION },
      data: { backgroundTasks: 1 },
    });
    t.clock.advance(60 * MIN);
    await t.observer.poll();
    expect(t.observed()).toEqual([]);
    // The task ends: the next stop has none, and silence counts again.
    t.observer.hookSeen({
      type: 'hook.stopped',
      session: { runtime: 'claude', id: SESSION },
      data: { backgroundTasks: 0 },
    });
    t.clock.advance(10 * MIN);
    await t.observer.poll();
    expect(t.observed().map((o) => o.kind)).toEqual(['silent']);
  });

  it('a question the worker asks is no incident and goes to no classifier (#473)', async () => {
    const t = setup();
    t.setPane(
      readFileSync(
        join(
          import.meta.dir,
          '..',
          'cards',
          '__fixtures__',
          'ask-user-question.txt',
        ),
        'utf8',
      ),
    );
    t.clock.advance(90 * MIN);
    await t.observer.poll();
    await t.settle();
    expect(t.observed()).toEqual([]);
    expect(t.classified).toEqual([]);
  });

  it('an unexplained silent stall goes to haiku once, and its one line is the reason', async () => {
    const t = setup();
    t.setPane(BUSY);
    t.clock.advance(10 * MIN);
    await t.observer.poll();
    await t.settle();
    await t.observer.poll();
    await t.settle();
    expect(t.classified).toHaveLength(1);
    expect(t.observed()).toEqual([
      expect.objectContaining({
        kind: 'unknown',
        reason: 'a wait loop polls pgrep -f and matches itself',
        classifierSessionId: CLASSIFIER_SESSION,
      }),
    ]);
  });

  it('a failed classification falls back to silent', async () => {
    const t = setup({ classify: async () => null });
    t.setPane(BUSY);
    t.clock.advance(10 * MIN);
    await t.observer.poll();
    await t.settle();
    expect(t.observed()).toEqual([expect.objectContaining({ kind: 'silent' })]);
    expect(t.observed()[0]).not.toHaveProperty('classifierSessionId');
  });
});

describe('StewardObserver — privacy and switches (#447 D12, D16)', () => {
  it('with session content off, no pane text reaches the event', async () => {
    const t = setup();
    t.setPane(`token sk-abcdefghijklmnopqrstuvwxyz\n${API_ERROR}`);
    await t.observer.poll();
    const [event] = t.events;
    expect(event?.data).not.toHaveProperty('paneTail');
    expect(JSON.stringify(event)).not.toContain('Running the checks');
    expect(JSON.stringify(event)).not.toContain('sk-abc');
  });

  it('with session content on, the redacted pane tail goes with it', async () => {
    const t = setup({ project: { shipContent: true } });
    t.setPane(`OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz\n${API_ERROR}`);
    await t.observer.poll();
    const data = t.observed()[0];
    expect(data?.paneTail).toContain('Connection lost mid-response');
    expect(data?.paneTail).not.toContain('sk-abc');
  });

  it('Steward off, or absent, observes nothing', async () => {
    for (const project of [
      { steward: { ...steward, enabled: false } },
      { steward: undefined },
    ]) {
      const t = setup({ project });
      t.setPane(API_ERROR);
      t.clock.advance(60 * MIN);
      await t.observer.poll();
      t.observer.sessionEnded(t.records[0] as CardRecord, 1);
      expect(t.events).toEqual([]);
    }
  });

  it('a round the runner stopped is never observed', async () => {
    const t = setup();
    t.records[0] = record({ phase: 'stopped' });
    t.setPane(API_ERROR);
    await t.observer.poll();
    expect(t.events).toEqual([]);
  });
});

describe('StewardObserver — dead sessions and runs (#447 D6, D10)', () => {
  it('a gone card session is reported as dead_session', () => {
    const t = setup();
    t.observer.sessionEnded(record({ phase: 'ended' }), null);
    expect(t.observed()).toEqual([
      expect.objectContaining({
        kind: 'dead_session',
        reason: "the card's session is gone",
        subject: { kind: 'card_round', cardId: 'card_1', runId: 'run_1' },
      }),
    ]);
  });

  it('a skill run with no output past the threshold is silent', async () => {
    const run: StewardRun = {
      runId: 'run_9',
      projectId: 'prj_widget',
      repo: 'widget',
      root: '/home/dev/widget',
      startedAt: new Date(START).toISOString(),
      streamFile: '/state/runs/run_9/stream.jsonl',
    };
    const t = setup({ runs: [run], mtime: START + 5 * MIN });
    t.clock.advance(14 * MIN);
    await t.observer.poll();
    expect(t.observed().filter((o) => o.subject.kind === 'run')).toEqual([]);
    t.clock.advance(1 * MIN);
    await t.observer.poll();
    expect(t.observed().filter((o) => o.subject.kind === 'run')).toEqual([
      expect.objectContaining({
        subject: { kind: 'run', runId: 'run_9' },
        kind: 'silent',
        reason: 'the run has written no output for 10+ min',
      }),
    ]);
  });
});
