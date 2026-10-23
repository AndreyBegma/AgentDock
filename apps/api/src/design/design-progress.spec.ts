import {
  lastFailureOf,
  loadDesignProgress,
  type ProgressBuild,
  type ProgressDesign,
  type ProgressTurn,
  progressOf,
} from './design-progress';
import type { Db } from './design-store';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 22, 22, minute));

const design = (patch: Partial<ProgressDesign> = {}): ProgressDesign => ({
  id: 'design-1',
  status: 'generating',
  variantCount: 1,
  busySince: at(0),
  approvedAt: null,
  revisions: [],
  ...patch,
});

const turn = (patch: Partial<ProgressTurn> = {}): ProgressTurn => ({
  id: 'turn-1',
  phase: 'running',
  error: null,
  createdAt: at(1),
  finishedAt: null,
  run: {
    id: 'run-1',
    startedAt: at(1),
    args: {
      design: {
        mode: 'generate',
        variant: 1,
        remaining: [],
        comments: [],
        profileId: null,
      },
    },
  },
  ...patch,
});

const build = (patch: Partial<ProgressBuild> = {}): ProgressBuild => ({
  id: 'build-1',
  status: 'running',
  outcome: null,
  startedAt: at(0),
  endedAt: null,
  args: {},
  ...patch,
});

/** A `Db` whose latest design turn and build are the given ones. */
const dbWith = (latest: {
  turn: ProgressTurn | null;
  build: ProgressBuild | null;
}): Db =>
  ({
    planTurn: { findFirst: () => Promise.resolve(latest.turn) },
    run: { findFirst: () => Promise.resolve(latest.build) },
  }) as unknown as Db;

describe('progressOf (#275 D1)', () => {
  it('reports the running turn of a busy design', () => {
    expect(progressOf(design(), { turn: turn(), build: null })).toMatchObject({
      stage: 'draw',
      phase: 'running',
      turnId: 'turn-1',
      runId: 'run-1',
      variant: 1,
    });
  });

  it('reports the running build while no turn is active', () => {
    expect(
      progressOf(design(), {
        turn: turn({ phase: 'succeeded', finishedAt: at(2) }),
        build: build(),
      }),
    ).toMatchObject({ stage: 'profile', phase: 'running', step: 1 });
  });

  it('is null at rest with no turn active', () => {
    expect(
      progressOf(design({ status: 'reviewing', busySince: null }), {
        turn: turn({ phase: 'succeeded', finishedAt: at(2) }),
        build: build(),
      }),
    ).toBeNull();
  });

  // #840: the turn is still finishing while the status already rests.
  it('reports a queued or running turn whatever the status says', () => {
    for (const status of ['idle', 'reviewing'] as const) {
      const resting = design({ status, busySince: null });
      expect(progressOf(resting, { turn: turn(), build: null })).toMatchObject({
        stage: 'draw',
        phase: 'running',
        turnId: 'turn-1',
      });
      expect(
        progressOf(resting, { turn: turn({ phase: 'queued' }), build: null }),
      ).toMatchObject({ phase: 'queued', turnId: 'turn-1' });
    }
  });
});

describe('lastFailureOf (#275 D6)', () => {
  const failed = turn({
    phase: 'failed',
    error: 'boom',
    finishedAt: at(3),
  });

  it('reports the failed turn at rest', () => {
    expect(
      lastFailureOf(design({ status: 'idle', busySince: null }), {
        turn: failed,
        build: null,
      }),
    ).toMatchObject({ stage: 'draw', reason: 'failed', message: 'boom' });
  });

  it('is null while a turn is active, whatever the status says (#840)', () => {
    expect(
      lastFailureOf(design({ status: 'idle', busySince: null }), {
        turn: turn(),
        build: build({ status: 'failed', endedAt: at(0) }),
      }),
    ).toBeNull();
  });
});

describe('loadDesignProgress (#840)', () => {
  it('reads a resting design with a running turn as busy', async () => {
    const view = await loadDesignProgress(
      dbWith({ turn: turn(), build: null }),
      'project-1',
      { stackId: 'stack-1' },
      design({ status: 'idle', busySince: null }),
    );
    expect(view.activeTurnId).toBe('turn-1');
    expect(view.progress).toMatchObject({ turnId: 'turn-1', phase: 'running' });
    expect(view.lastFailure).toBeNull();
  });

  it('reads a finished turn as no active turn', async () => {
    const view = await loadDesignProgress(
      dbWith({
        turn: turn({ phase: 'cancelled', finishedAt: at(3) }),
        build: null,
      }),
      'project-1',
      { stackId: 'stack-1' },
      design({ status: 'idle', busySince: null }),
    );
    expect(view.activeTurnId).toBeNull();
    expect(view.progress).toBeNull();
    expect(view.lastFailure).toMatchObject({ reason: 'stopped' });
  });
});
