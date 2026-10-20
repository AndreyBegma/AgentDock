import { describe, expect, test } from 'bun:test';
import type {
  ApprovalsView,
  FleetView,
  RunSummary,
  SlotSummary,
} from '@agentdock/shared';
import { isTask, needsYou, recentResult, summarySentence } from './summary';

const run = (over: Partial<RunSummary>): RunSummary =>
  ({
    id: 'r',
    kind: 'orchestrator_slot',
    projectId: 'p1',
    slot: 'i7',
    issue: 7,
    title: null,
    status: 'succeeded',
    updatedAt: '2026-10-14T08:00:00.000Z',
    ...over,
  }) as RunSummary;

const slot = (over: Partial<SlotSummary>): SlotSummary =>
  ({
    id: 's1',
    name: 'i7',
    issue: 7,
    branch: 'feat/7',
    status: 'running',
    prNumber: null,
    prChecks: null,
    updatedAt: '2026-10-14T08:00:00.000Z',
    ...over,
  }) as SlotSummary;

const fleet = (slots: SlotSummary[], max?: number): FleetView =>
  ({
    slots,
    latestRound: max === undefined ? null : { max },
  }) as FleetView;

describe('isTask', () => {
  test('bookkeeping runs are not tasks', () => {
    expect(isTask({ kind: 'card_capture' })).toBe(false);
    expect(isTask({ kind: 'orchestrator_slot' })).toBe(true);
  });
});

describe('recentResult', () => {
  test('the newest task that succeeded or failed', () => {
    const runs = [
      run({ id: 'a', status: 'running' }),
      run({ id: 'b', kind: 'card_capture' }),
      run({ id: 'c', status: 'failed' }),
      run({ id: 'd' }),
    ];
    expect(recentResult(runs)?.id).toBe('c');
  });

  test('nothing finished is no result', () => {
    expect(recentResult([run({ status: 'running' })])).toBeUndefined();
  });
});

describe('needsYou', () => {
  const approvals = {
    waiting: [
      {
        id: 'x',
        pr: 684,
        title: 'Run the migration',
        slot: 'i2',
        waitingSince: 't',
      },
    ],
  } as ApprovalsView;

  test('collects approvals, dialogs, failing checks and runs asking for a person', () => {
    const items = needsYou(
      'p1',
      approvals,
      fleet([
        slot({ id: 's2', name: 'i2', status: 'prompt' }),
        slot({ id: 's3', name: 'i3', prNumber: 690, prChecks: 'red' }),
        slot({ id: 's4', name: 'i4', status: 'ended', prChecks: 'red' }),
      ]),
      [run({ id: 'w', status: 'waiting_person', title: 'Pick a plan' })],
    );
    expect(items.map((i) => i.kind)).toEqual([
      'approval',
      'prompt',
      'checks',
      'run',
    ]);
    expect(items[0]).toMatchObject({
      title: 'Run the migration',
      detail: '#684 · i2',
      href: '/projects/p1/approvals',
    });
    expect(items[1]?.href).toBe('/projects/p1/fleet?open=i2&focus=i2');
    expect(items[2]?.title).toBe('Checks failed on #690');
    expect(items[3]?.href).toBe('/projects/p1/history/w');
  });

  test('nothing loaded, nothing waits', () => {
    expect(needsYou('p1', undefined, undefined, [])).toEqual([]);
  });
});

describe('summarySentence', () => {
  test('unknown before the fleet loads', () => {
    expect(summarySentence(undefined, 0)).toBeUndefined();
  });

  test('counts working slots against the round and what waits', () => {
    const view = fleet(
      [
        slot({}),
        slot({ id: 's2', status: 'idle' }),
        slot({ id: 's3', status: 'ended' }),
      ],
      4,
    );
    expect(summarySentence(view, 2)).toBe(
      '1 of 4 slots are working. 2 things need you.',
    );
  });

  test('an empty fleet and an empty inbox', () => {
    expect(summarySentence(fleet([]), 0)).toBe(
      'No slots are working. Nothing needs you.',
    );
  });
});
