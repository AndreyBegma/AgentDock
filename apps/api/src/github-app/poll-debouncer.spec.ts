import { GITHUB_POLL_DEBOUNCE_MS } from '@agentdock/shared';
import { type DebouncedPoll, PollDebouncer } from './poll-debouncer';

describe('PollDebouncer (spec 27 D8)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const setup = () => {
    const sent: { at: number; poll: DebouncedPoll }[] = [];
    const start = Date.now();
    const debouncer = new PollDebouncer({
      windowMs: GITHUB_POLL_DEBOUNCE_MS,
      flush: async (poll) => {
        sent.push({ at: Date.now() - start, poll });
      },
    });
    return { sent, debouncer };
  };

  it('sends one poll for a burst of 20 requests in 3 s, within 5 s of the first', async () => {
    const { sent, debouncer } = setup();
    for (let i = 0; i < 20; i += 1) {
      debouncer.request('p1', ['prs']);
      await jest.advanceTimersByTimeAsync(150);
    }
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sent).toHaveLength(1);
    expect(sent[0].poll).toEqual({ projectId: 'p1', collectors: ['prs'] });
    expect(sent[0].at).toBeLessThanOrEqual(5_000);
  });

  it('unions the collectors asked within one window', async () => {
    const { sent, debouncer } = setup();
    debouncer.request('p1', ['prs']);
    debouncer.request('p1', ['issues']);
    debouncer.request('p1', ['prs', 'worktrees']);
    await jest.advanceTimersByTimeAsync(GITHUB_POLL_DEBOUNCE_MS);
    expect(sent.map((s) => s.poll)).toEqual([
      { projectId: 'p1', collectors: ['issues', 'prs', 'worktrees'] },
    ]);
  });

  it('debounces per project, and opens a new window after a flush', async () => {
    const { sent, debouncer } = setup();
    debouncer.request('p1', ['issues']);
    debouncer.request('p2', ['issues']);
    await jest.advanceTimersByTimeAsync(GITHUB_POLL_DEBOUNCE_MS);
    expect(sent.map((s) => s.poll.projectId).sort()).toEqual(['p1', 'p2']);
    debouncer.request('p1', ['issues']);
    await jest.advanceTimersByTimeAsync(GITHUB_POLL_DEBOUNCE_MS);
    expect(sent).toHaveLength(3);
  });

  it('survives a failing send', async () => {
    const debouncer = new PollDebouncer({
      windowMs: 10,
      flush: () => Promise.reject(new Error('offline')),
    });
    debouncer.request('p1', ['prs']);
    await jest.advanceTimersByTimeAsync(10);
    await expect(debouncer.flushAll()).resolves.toBeUndefined();
    expect(debouncer.waiting).toBe(0);
  });
});
