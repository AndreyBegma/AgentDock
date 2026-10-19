import { describe, expect, test } from 'bun:test';
import type {
  BoardStackDetail,
  StackCardView,
  StackRunView,
} from '@agentdock/shared';
import { autoRunFailureText } from './format';
import {
  canStopStack,
  pauseText,
  runStackControl,
  stackFaceRunPill,
  stackRunPill,
} from './stack-page';

/** #652: what the stack page and the Board stack face say of Run stack. */

const card = (over: Partial<StackCardView> = {}): StackCardView => ({
  number: 1,
  label: 'C-1',
  title: 'Part',
  column: 'todo',
  round: null,
  design: null,
  prNumber: null,
  prUrl: null,
  prTarget: null,
  after: [],
  costUsd: null,
  run: null,
  ...over,
});

const run = (over: Partial<StackRunView> = {}): StackRunView => ({
  state: 'running',
  pause: null,
  queued: 1,
  waiting: 0,
  running: 2,
  startedAt: '2026-10-19T12:00:00.000Z',
  ...over,
});

const detail = (over: Partial<BoardStackDetail> = {}): BoardStackDetail => ({
  id: 'stack-1',
  number: 1,
  label: 'S-1',
  title: 'Payments',
  column: 'todo',
  accepted: 0,
  total: 2,
  currentStage: 0,
  costUsd: null,
  run: null,
  body: '',
  planId: null,
  started: false,
  createdAt: '2026-10-19T12:00:00.000Z',
  updatedAt: '2026-10-19T12:00:00.000Z',
  design: null,
  stages: [
    {
      position: 0,
      title: '',
      cards: [card(), card({ number: 2, label: 'C-2' })],
    },
  ],
  ...over,
});

const approved = {
  needed: true,
  suggested: true,
  suggestionWhy: null,
  variantCount: 1,
  approvedRevisionId: 'rev-1',
  busySince: null,
} as const;

describe('runStackControl', () => {
  test('is enabled for an operator with cards in To Do', () => {
    expect(runStackControl(detail(), true)).toEqual({
      label: 'Run stack',
      disabled: false,
      reason: null,
    });
  });

  test('is disabled for a viewer', () => {
    expect(runStackControl(detail(), false)).toMatchObject({
      disabled: true,
      reason: 'Operators run a stack',
    });
  });

  test('is disabled while the stack design is needed and not approved', () => {
    const gated = detail({ design: { ...approved, status: 'reviewing' } });
    expect(runStackControl(gated, true)).toMatchObject({
      disabled: true,
      reason: 'Waits for the stack design to be approved',
    });
    const open = detail({ design: { ...approved, status: 'approved' } });
    expect(runStackControl(open, true).disabled).toBe(false);
  });

  test('is disabled once every To Do card is queued, and resumes a paused run', () => {
    const queued = detail({
      run: run(),
      stages: [{ position: 0, title: '', cards: [card({ run: 'queued' })] }],
    });
    expect(runStackControl(queued, true)).toMatchObject({
      disabled: true,
      reason: 'Every card in To Do is queued already',
    });
    const paused = { ...queued, run: run({ state: 'paused' }) };
    expect(runStackControl(paused, true)).toEqual({
      label: 'Resume stack',
      disabled: false,
      reason: null,
    });
  });
});

describe('the run state', () => {
  test('Stop is offered while cards are queued or the run is paused', () => {
    expect(canStopStack(null)).toBe(false);
    expect(canStopStack(run())).toBe(true);
    expect(canStopStack(run({ queued: 0, waiting: 0 }))).toBe(false);
    expect(canStopStack(run({ state: 'paused', queued: 0 }))).toBe(true);
    expect(canStopStack(run({ state: 'done', queued: 0 }))).toBe(false);
  });

  test('the page pill counts running, queued and waiting cards', () => {
    expect(stackRunPill(run({ waiting: 1 }))).toEqual({
      status: 'running',
      label: 'Running · 2 running · 1 queued · 1 waiting for a dependency',
    });
    expect(stackRunPill(run({ state: 'done', queued: 0, running: 0 }))).toEqual(
      { status: 'done', label: 'Done' },
    );
  });

  test('the face says running, queued, paused or done; nothing once stopped', () => {
    expect(stackFaceRunPill({ run: null })).toBeNull();
    expect(stackFaceRunPill({ run: run() })?.label).toBe('2 running');
    expect(stackFaceRunPill({ run: run({ running: 0 }) })?.label).toBe(
      'Run queued',
    );
    expect(stackFaceRunPill({ run: run({ state: 'paused' }) })).toEqual({
      status: 'paused',
      label: 'Run paused',
    });
    expect(stackFaceRunPill({ run: run({ state: 'stopped' }) })).toBeNull();
  });

  test('a pause says which card did not start and why', () => {
    expect(pauseText(run())).toBeNull();
    const budget = pauseText(
      run({
        state: 'paused',
        pause: {
          code: 'no_profile',
          message: 'No runtime profile is set up.',
          card: 4,
          at: '2026-10-19T12:00:00.000Z',
        },
      }),
    );
    expect(budget).toStartWith('C-4 did not start: ');
    expect(budget).toEndWith('.');
    expect(
      pauseText(
        run({
          state: 'paused',
          pause: {
            code: 'round_failed',
            message: 'The round of C-4 failed: the runner could not start',
            card: 4,
            at: '2026-10-19T12:00:00.000Z',
          },
        }),
      ),
    ).toBe('The round of C-4 failed: the runner could not start.');
  });

  test('a card Run stack paused on says so on its face', () => {
    expect(
      autoRunFailureText({
        code: 'unknown',
        message: 'Something broke.',
        at: '2026-10-19T12:00:00.000Z',
        after: null,
        stack: 5,
      }),
    ).toBe('Run stack S-5 could not start it and paused: Something broke');
  });
});
