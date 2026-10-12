import { type CurrentTimers, isOrphan } from './schedule-reconciler';
import { fireJobId, jobWillRun, within } from './schedule-timers';

const at = (s: string) => new Date(s);

describe('fireJobId (spec 123 B3)', () => {
  it('is fire-<scheduleId>-<epoch ms>, without the colon BullMQ forbids', () => {
    const id = fireJobId('cm1abc', at('2026-10-09T10:00:00Z'));
    expect(id).toBe(`fire-cm1abc-${Date.UTC(2026, 9, 9, 10)}`);
    expect(id).not.toContain(':');
  });
});

describe('the reconciler diff (spec 123 B9)', () => {
  it('(a) a missing, completed or failed job is restored; a pending one is left alone', () => {
    for (const state of ['completed', 'failed', 'unknown']) {
      expect([state, jobWillRun(state)]).toEqual([state, false]);
    }
    for (const state of ['delayed', 'waiting', 'active', 'prioritized']) {
      expect([state, jobWillRun(state)]).toEqual([state, true]);
    }
  });

  it('(b) a delayed job no enabled row points at is an orphan', () => {
    const t = at('2026-10-09T10:00:00Z');
    const current: CurrentTimers = new Map([['s1', t.getTime()]]);
    const job = (scheduleId: string, scheduledFor: Date) => ({
      jobId: fireJobId(scheduleId, scheduledFor),
      data: { scheduleId, scheduledFor: scheduledFor.toISOString() },
    });
    expect(isOrphan(job('s1', t), current)).toBe(false);
    // The row moved to another occurrence.
    expect(isOrphan(job('s1', at('2026-10-09T11:00:00Z')), current)).toBe(true);
    // Deleted or disabled: not in the map.
    expect(isOrphan(job('gone', t), current)).toBe(true);
  });
});

describe('within (spec 123 B8)', () => {
  it('passes a prompt answer through and gives up on a silent one', async () => {
    await expect(within(Promise.resolve(1), 50)).resolves.toBe(1);
    await expect(within(new Promise(() => undefined), 20)).rejects.toThrow(
      /no answer from Redis/,
    );
  });
});
