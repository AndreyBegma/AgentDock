import { describe, expect, test } from 'bun:test';
import type { RunSummary } from '@agentdock/shared';
import {
  costTrend,
  isTask,
  leadTimes,
  leadTimeTrend,
  median,
  parsePeriod,
  percentDelta,
  periodRanges,
  shortDuration,
  successRate,
  throughput,
  timeByKind,
} from './analytics';

const run = (over: Partial<RunSummary>): RunSummary => ({
  id: 'r',
  kind: 'orchestrator_slot',
  projectId: 'p1',
  slotId: 's7',
  slot: 'i7',
  issue: 7,
  title: null,
  runtime: 'claude',
  model: null,
  profileKey: null,
  output: 'pr',
  status: 'succeeded',
  outcome: null,
  prNumber: 70,
  prUrl: null,
  prChecks: null,
  planId: null,
  triggeredByType: 'orchestrator',
  triggeredById: null,
  startedAt: '2026-10-14T05:00:00.000Z',
  endedAt: '2026-10-14T08:00:00.000Z',
  durationMs: 3 * 3_600_000,
  updatedAt: '2026-10-14T08:00:00.000Z',
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    reasoning: 0,
    requests: 0,
    costUsd: null,
    unpricedRequests: 0,
  },
  ...over,
});

const NOW = new Date('2026-10-15T10:30:00.000Z');

describe('periods', () => {
  test('an unknown ?period= is the default week', () => {
    expect(parsePeriod('30d')).toBe('30d');
    expect(parsePeriod('1y')).toBe('7d');
    expect(parsePeriod(null)).toBe('7d');
  });

  test('the previous range is the same length, just before', () => {
    const { current, previous, bucketMs } = periodRanges('7d', NOW);
    expect(current.to).toBe('2026-10-15T11:00:00.000Z');
    expect(current.from).toBe('2026-10-08T11:00:00.000Z');
    expect(previous).toEqual({
      from: '2026-10-01T11:00:00.000Z',
      to: '2026-10-08T11:00:00.000Z',
    });
    expect(bucketMs).toBe(86_400_000);
    expect(periodRanges('24h', NOW).bucketMs).toBe(3_600_000);
  });
});

describe('throughput', () => {
  test('counts merged and failed runs by the bucket they ended in', () => {
    const { current, bucketMs } = periodRanges('7d', NOW);
    const t = throughput(
      [
        run({ endedAt: '2026-10-14T12:00:00.000Z' }),
        run({ endedAt: '2026-10-14T13:00:00.000Z' }),
        run({ status: 'failed', endedAt: '2026-10-09T12:00:00.000Z' }),
        // Still at work, out of range, or merged without a PR: not counted.
        run({ status: 'running', endedAt: null }),
        run({ endedAt: '2026-09-01T00:00:00.000Z' }),
        run({ prNumber: null, endedAt: '2026-10-14T12:00:00.000Z' }),
      ],
      current,
      bucketMs,
    );
    expect(t.starts).toHaveLength(7);
    expect(t.merged).toEqual([0, 0, 0, 0, 0, 0, 2]);
    expect(t.failed).toEqual([0, 1, 0, 0, 0, 0, 0]);
  });
});

describe('lead time', () => {
  test('median of odd and even sets; null for none', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  test('only merged runs with a duration count', () => {
    expect(
      leadTimes([
        run({ durationMs: 10 }),
        run({ status: 'failed', durationMs: 99 }),
        run({ durationMs: null }),
      ]),
    ).toEqual([10]);
  });

  test('the trend is per bucket, zero where nothing merged', () => {
    const { current, bucketMs } = periodRanges('7d', NOW);
    const trend = leadTimeTrend(
      [
        run({ endedAt: '2026-10-14T12:00:00.000Z', durationMs: 100 }),
        run({ endedAt: '2026-10-14T13:00:00.000Z', durationMs: 300 }),
      ],
      current,
      bucketMs,
    );
    expect(trend).toEqual([0, 0, 0, 0, 0, 0, 200]);
  });
});

describe('success rate', () => {
  test('merged out of finished; null before anything finished', () => {
    expect(successRate({ succeeded: 3, failed: 1 })).toBe(0.75);
    expect(successRate({ succeeded: 0, failed: 0 })).toBeNull();
  });
});

describe('cost trend', () => {
  test('sums every series per point, oldest first', () => {
    expect(
      costTrend({
        series: [
          {
            key: 'claude',
            label: null,
            points: [
              {
                t: '2026-10-14T00:00:00Z',
                costUsd: '2',
                tokens: 0,
                requests: 0,
                unpricedRequests: 0,
              },
              {
                t: '2026-10-13T00:00:00Z',
                costUsd: '1',
                tokens: 0,
                requests: 0,
                unpricedRequests: 0,
              },
            ],
          },
          {
            key: 'codex',
            label: null,
            points: [
              {
                t: '2026-10-14T00:00:00Z',
                costUsd: '0.5',
                tokens: 0,
                requests: 0,
                unpricedRequests: 0,
              },
            ],
          },
        ],
      }),
    ).toEqual([1, 2.5]);
  });
});

describe('percentDelta', () => {
  test('the sentiment follows what is good, not the direction', () => {
    expect(percentDelta(13, 10, true)).toEqual({
      value: '30%',
      direction: 'up',
      sentiment: 'good',
    });
    expect(percentDelta(13, 10, false)?.sentiment).toBe('bad');
    expect(percentDelta(5, 10, false)).toEqual({
      value: '50%',
      direction: 'down',
      sentiment: 'good',
    });
  });

  test('nothing to compare with is no delta, not "+∞%"', () => {
    expect(percentDelta(4, 0, true)).toBeUndefined();
    expect(percentDelta(4, null, true)).toBeUndefined();
    expect(percentDelta(10, 10, true)?.direction).toBe('flat');
  });
});

describe('time by kind', () => {
  test('shares of task time, largest first; housekeeping is left out', () => {
    const shares = timeByKind(
      [
        run({ durationMs: 300 }),
        run({ kind: 'skill', durationMs: 100 }),
        run({ kind: 'text_normalize', durationMs: 5_000 }),
      ],
      NOW.getTime(),
    );
    expect(shares).toEqual([
      { kind: 'orchestrator_slot', ms: 300, share: 0.75 },
      { kind: 'skill', ms: 100, share: 0.25 },
    ]);
    expect(isTask(run({ kind: 'card_capture' }))).toBe(false);
  });

  test('a run still at work counts up to now', () => {
    const [share] = timeByKind(
      [
        run({
          status: 'running',
          endedAt: null,
          durationMs: null,
          startedAt: '2026-10-15T10:00:00.000Z',
        }),
      ],
      NOW.getTime(),
    );
    expect(share?.ms).toBe(30 * 60_000);
  });

  test('an ended run without a duration counts start to end', () => {
    const [share] = timeByKind([run({ durationMs: null })], NOW.getTime());
    expect(share?.ms).toBe(3 * 3_600_000);
  });
});

test('shortDuration', () => {
  expect(shortDuration(45_000)).toBe('45s');
  expect(shortDuration(18 * 60_000)).toBe('18m');
  expect(shortDuration((3 * 60 + 42) * 60_000)).toBe('3h 42m');
  expect(shortDuration(3 * 86_400_000)).toBe('3d');
  expect(shortDuration(null)).toBe('—');
});
