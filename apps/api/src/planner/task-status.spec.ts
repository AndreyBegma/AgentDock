import { type LiveStatusInput, liveStatusOf } from './task-status';

const base: LiveStatusInput = {
  issue: { state: 'open', labels: [], closedBy: null, closingPr: null },
  readyLabel: 'cs:ready',
  queueState: null,
  openPr: null,
  queuedAt: null,
};

describe('liveStatusOf', () => {
  it('is null for an issued task that is not queued yet', () => {
    expect(liveStatusOf(base)).toEqual({ status: null, prNumber: null });
  });

  it('is queued when the issue carries the ready label', () => {
    expect(
      liveStatusOf({
        ...base,
        issue: {
          state: 'open',
          labels: ['bug', 'cs:ready'],
          closedBy: null,
          closingPr: null,
        },
      }).status,
    ).toBe('queued');
  });

  it('trusts queuedAt only while the cache has not seen the issue', () => {
    const at = new Date();
    expect(liveStatusOf({ ...base, issue: null, queuedAt: at }).status).toBe(
      'queued',
    );
    expect(liveStatusOf({ ...base, queuedAt: at }).status).toBeNull();
  });

  it('is in flight from the queue state, then pr_open from an open PR', () => {
    expect(liveStatusOf({ ...base, queueState: 'in_flight' }).status).toBe(
      'in_flight',
    );
    expect(
      liveStatusOf({
        ...base,
        queueState: 'in_flight',
        openPr: { number: 9, url: 'https://github.com/a/b/pull/9' },
      }),
    ).toEqual({ status: 'pr_open', prNumber: 9 });
  });

  it('is merged when a pull request closed it, closed otherwise', () => {
    expect(
      liveStatusOf({
        ...base,
        issue: { state: 'closed', labels: [], closedBy: 'pr', closingPr: 12 },
      }),
    ).toEqual({ status: 'merged', prNumber: 12 });
    expect(
      liveStatusOf({
        ...base,
        issue: {
          state: 'closed',
          labels: [],
          closedBy: 'manual',
          closingPr: null,
        },
      }),
    ).toEqual({ status: 'closed', prNumber: null });
  });
});
