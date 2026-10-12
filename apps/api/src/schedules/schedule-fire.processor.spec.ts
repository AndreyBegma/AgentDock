import {
  decideFire,
  type LockedRow,
  redelayMs,
} from './schedule-fire.processor';

const at = (s: string) => new Date(s);
const due = at('2026-10-09T10:00:00Z');

const row = (patch: Partial<LockedRow> = {}): LockedRow => ({
  id: 's1',
  projectId: 'p1',
  runnerId: 'r1',
  cron: '0 * * * *',
  timezone: 'UTC',
  missedPolicy: 'catch_up',
  enabled: true,
  nextRunAt: due,
  ...patch,
});

const decide = (
  patch: Partial<Parameters<typeof decideFire>[0]> = {},
): ReturnType<typeof decideFire> =>
  decideFire({
    row: row(),
    scheduledFor: due,
    offlineRecorded: false,
    runnerConnected: true,
    now: at('2026-10-09T10:00:05Z'),
    ...patch,
  });

describe('decideFire (spec 123 B2, B5)', () => {
  it('claims the occurrence the row still points at', () => {
    expect(decide()).toBe('claim');
  });

  it('is stale for a missing, disabled or moved row', () => {
    expect(decide({ row: null })).toBe('stale');
    expect(decide({ row: row({ enabled: false }) })).toBe('stale');
    expect(decide({ row: row({ nextRunAt: null }) })).toBe('stale');
    expect(
      decide({ row: row({ nextRunAt: at('2026-10-09T11:00:00Z') }) }),
    ).toBe('stale');
    // A replay of the job the row has already moved past.
    expect(decide({ scheduledFor: at('2026-10-09T09:00:00Z') })).toBe('stale');
  });

  it('D9: a catch_up occurrence that failed offline waits while the runner is away', () => {
    const offline = { offlineRecorded: true, runnerConnected: false };
    expect(decide(offline)).toBe('wait');
    // The runner is back: claim it (it fires as catch_up).
    expect(decide({ ...offline, runnerConnected: true })).toBe('claim');
    // Only catch_up waits.
    expect(decide({ ...offline, row: row({ missedPolicy: 'skip' }) })).toBe(
      'claim',
    );
    // Nothing recorded yet: the first attempt claims.
    expect(decide({ runnerConnected: false })).toBe('claim');
  });

  it('D9: never waits past 24 hours; the claim then records it skipped', () => {
    const offline = { offlineRecorded: true, runnerConnected: false };
    expect(decide({ ...offline, now: at('2026-10-10T10:00:00Z') })).toBe(
      'wait',
    );
    expect(decide({ ...offline, now: at('2026-10-10T10:00:01Z') })).toBe(
      'claim',
    );
  });
});

describe('redelayMs (spec 123 B7)', () => {
  it('backs off 30 s, 60 s, 120 s, 240 s, then every 300 s', () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(redelayMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000,
    ]);
  });
});
