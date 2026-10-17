import { describe, expect, test } from 'bun:test';
import {
  type DesignFailureView,
  type DesignProgressView,
  STALL_AFTER_MS,
} from '@agentdock/shared';
import { design } from './fixtures';
import {
  failureSentence,
  formatClock,
  isStalled,
  isStarting,
  lastOutputOf,
  progressLabel,
  WAITING_FOR_SLOT,
} from './progress';

const STARTED = '2026-10-15T10:00:00.000Z';
const T0 = Date.parse(STARTED);

const progress = (
  patch: Partial<DesignProgressView> = {},
): DesignProgressView => ({
  stage: 'draw',
  phase: 'running',
  runId: 'run-1',
  turnId: 'turn-1',
  variant: 2,
  variantCount: 3,
  step: null,
  startedAt: STARTED,
  ...patch,
});

const failure = (
  patch: Partial<DesignFailureView> = {},
): DesignFailureView => ({
  stage: 'draw',
  mode: 'generate',
  reason: 'failed',
  message: '',
  variant: 2,
  at: STARTED,
  ...patch,
});

describe('progressLabel', () => {
  test('the profile build is step 1', () => {
    expect(
      progressLabel(
        progress({ stage: 'profile', step: 1, turnId: null, variant: null }),
      ),
    ).toBe('Step 1/2 · Building the UI profile');
  });

  test('a turn after a build is step 2', () => {
    expect(progressLabel(progress({ step: 2, variant: 1 }))).toBe(
      'Step 2/2 · Drawing variant 1 of 3',
    );
  });

  test('no build, no step prefix', () => {
    expect(progressLabel(progress())).toBe('Drawing variant 2 of 3');
    expect(progressLabel(progress({ stage: 'revise' }))).toBe(
      'Revising variant 2 of 3',
    );
  });

  test('a queued run waits for a slot whatever the stage', () => {
    expect(progressLabel(progress({ phase: 'queued', step: 2 }))).toBe(
      WAITING_FOR_SLOT,
    );
    expect(
      progressLabel(progress({ stage: 'profile', phase: 'queued', step: 1 })),
    ).toBe(WAITING_FOR_SLOT);
  });
});

describe('isStalled', () => {
  const now = T0 + STALL_AFTER_MS;

  test('five minutes after lastOutputAt', () => {
    const at = new Date(T0).toISOString();
    expect(isStalled(progress(), at, null, now)).toBe(true);
    expect(isStalled(progress(), at, null, now - 1)).toBe(false);
  });

  test('lastOutputAt wins over the arrival time of a live line', () => {
    const at = new Date(T0).toISOString();
    expect(isStalled(progress(), at, now, now)).toBe(true);
  });

  test('without lastOutputAt the newest live line counts', () => {
    expect(isStalled(progress(), null, T0 + 1_000, now)).toBe(false);
    expect(isStalled(progress(), null, T0, now)).toBe(true);
  });

  test('without either the job start counts', () => {
    expect(lastOutputOf(progress(), null, null)).toBe(T0);
    expect(isStalled(progress(), null, null, now)).toBe(true);
    expect(isStalled(progress(), null, null, now - 1)).toBe(false);
  });

  test('a queued run never stalls', () => {
    expect(
      isStalled(progress({ phase: 'queued' }), null, null, T0 + 10 * 60_000),
    ).toBe(false);
  });
});

describe('failureSentence', () => {
  test('timed out, stopped, failed', () => {
    expect(failureSentence(failure({ reason: 'timed_out' }))).toBe(
      'Timed out while drawing variant 2.',
    );
    expect(
      failureSentence(
        failure({ reason: 'stopped', stage: 'revise', variant: 1 }),
      ),
    ).toBe('Stopped while revising variant 1.');
    expect(
      failureSentence(failure({ reason: 'failed', message: 'no runner' })),
    ).toBe('Failed while drawing variant 2: no runner');
  });

  test('the profile stage names the build', () => {
    expect(
      failureSentence(
        failure({ stage: 'profile', variant: null, reason: 'timed_out' }),
      ),
    ).toBe('Timed out while building the UI profile.');
  });
});

describe('formatClock', () => {
  test('m:ss', () => {
    expect(formatClock(192_000)).toBe('3:12');
    expect(formatClock(5_000)).toBe('0:05');
    expect(formatClock(-1)).toBe('0:00');
    expect(formatClock(3_600_000)).toBe('60:00');
  });
});

describe('a busy design with nothing running (#606)', () => {
  const running: DesignProgressView = {
    stage: 'draw',
    phase: 'running',
    runId: 'r1',
    turnId: 't1',
    variant: 2,
    variantCount: 2,
    step: null,
    startedAt: STARTED,
  };

  test('reads as starting, not as a design to generate', () => {
    expect(isStarting(design({ status: 'generating', progress: null }))).toBe(
      true,
    );
    expect(isStarting(design({ status: 'revising', progress: null }))).toBe(
      true,
    );
  });

  test('a running turn, or a design at rest, is not starting', () => {
    expect(
      isStarting(design({ status: 'generating', progress: running })),
    ).toBe(false);
    expect(isStarting(design({ status: 'idle', progress: null }))).toBe(false);
    expect(isStarting(design({ status: 'reviewing', progress: null }))).toBe(
      false,
    );
  });
});
