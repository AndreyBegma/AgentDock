import { describe, expect, it } from 'bun:test';
import { deriveRunStatus, type RunStatusInputs } from './status';

const slot = (extra: Partial<RunStatusInputs>): RunStatusInputs => ({
  status: 'running',
  prState: null,
  prNumber: null,
  lastCheckpoint: null,
  ...extra,
});

describe('deriveRunStatus (spec 21 D7)', () => {
  it('is succeeded only with a merged PR', () => {
    expect(
      deriveRunStatus(
        slot({ status: 'ended', prState: 'merged', prNumber: 4 }),
      ),
    ).toBe('succeeded');
    expect(
      deriveRunStatus(
        slot({ status: 'running', prState: 'merged', prNumber: 4 }),
      ),
    ).toBe('succeeded');
  });

  it('is failed when the PR closed unmerged and the worker is gone', () => {
    expect(
      deriveRunStatus(
        slot({ status: 'ended', prState: 'closed', prNumber: 4 }),
      ),
    ).toBe('failed');
    expect(
      deriveRunStatus(
        slot({ status: 'stale', prState: 'closed', prNumber: 4 }),
      ),
    ).toBe('failed');
  });

  it('is abandoned when the worker is gone without a PR', () => {
    expect(deriveRunStatus(slot({ status: 'ended' }))).toBe('abandoned');
    expect(
      deriveRunStatus(slot({ status: 'stale', lastCheckpoint: 'blocked' })),
    ).toBe('abandoned');
  });

  it('waits on a person for an open PR once the worker is done', () => {
    expect(
      deriveRunStatus(slot({ status: 'stale', prState: 'open', prNumber: 4 })),
    ).toBe('waiting_person');
    expect(
      deriveRunStatus(slot({ status: 'idle', prState: 'open', prNumber: 4 })),
    ).toBe('waiting_person');
    expect(deriveRunStatus(slot({ status: 'ended', prNumber: 4 }))).toBe(
      'waiting_person',
    );
  });

  it('is blocked on a blocked or misclassified checkpoint while alive', () => {
    expect(deriveRunStatus(slot({ lastCheckpoint: 'blocked' }))).toBe(
      'blocked',
    );
    expect(
      deriveRunStatus(
        slot({ status: 'idle', lastCheckpoint: 'misclassified' }),
      ),
    ).toBe('blocked');
  });

  it('waits on a person for a prompt or the quota', () => {
    expect(deriveRunStatus(slot({ status: 'prompt' }))).toBe('waiting_person');
    expect(deriveRunStatus(slot({ status: 'quota' }))).toBe('waiting_person');
  });

  it('is running otherwise, and again after a resume', () => {
    for (const status of ['dispatched', 'running', 'idle'] as const) {
      expect(deriveRunStatus(slot({ status }))).toBe('running');
    }
    expect(
      deriveRunStatus(
        slot({
          status: 'running',
          lastCheckpoint: 'pr_open',
          prState: 'open',
          prNumber: 2,
        }),
      ),
    ).toBe('running');
  });
});
