import { describe, expect, test } from 'bun:test';
import type { FleetView, UsageSeries } from '@agentdock/shared';
import {
  costQuery,
  costTrend,
  hasTrend,
  lastActivity,
  lastDays,
} from './overview';

const NOW = Date.parse('2026-10-13T15:30:00Z');

describe('lastDays', () => {
  test('seven UTC days, oldest first, today last', () => {
    const days = lastDays(NOW);
    expect(days).toHaveLength(7);
    expect(days[0]).toBe('2026-10-07T00:00:00.000Z');
    expect(days[6]).toBe('2026-10-13T00:00:00.000Z');
  });
});

describe('costQuery', () => {
  test('covers the seven days up to the end of today, per project', () => {
    const query = costQuery(NOW);
    expect(query).toContain('from=2026-10-07T00%3A00%3A00.000Z');
    expect(query).toContain('to=2026-10-14T00%3A00%3A00.000Z');
    expect(query).toContain('groupBy=project');
  });
});

describe('costTrend', () => {
  const series: UsageSeries[] = [
    {
      key: 'p1',
      label: 'One',
      points: [
        {
          t: '2026-10-09T00:00:00.000Z',
          costUsd: '1.5',
          tokens: 1,
          requests: 1,
          unpricedRequests: 0,
        },
        {
          t: '2026-10-13T00:00:00.000Z',
          costUsd: '0.5',
          tokens: 1,
          requests: 1,
          unpricedRequests: 0,
        },
      ],
    },
    { key: null, label: null, points: [] },
  ];

  test('zero-fills the days without spend and totals the rest', () => {
    const trend = costTrend(series, 'p1', lastDays(NOW));
    expect(trend.values).toEqual([0, 0, 1.5, 0, 0, 0, 0.5]);
    expect(trend.total).toBe(2);
  });

  test('a project with no series is all zeros, not missing', () => {
    expect(costTrend(series, 'other', lastDays(NOW))).toEqual({
      values: [0, 0, 0, 0, 0, 0, 0],
      total: 0,
    });
  });

  test('a sparkline needs two days with spend', () => {
    expect(hasTrend(costTrend(series, 'p1', lastDays(NOW)))).toBe(true);
    expect(hasTrend({ values: [0, 0, 3, 0], total: 3 })).toBe(false);
  });
});

describe('lastActivity', () => {
  const fleet = (createdAt: string | null, since: string | null): FleetView =>
    ({
      latestRound: createdAt ? { createdAt } : null,
      orchestrator: { status: 'running', session: null, since },
    }) as FleetView;

  test('the later of the last round and the last state change', () => {
    expect(
      lastActivity(
        fleet('2026-10-12T10:00:00.000Z', '2026-10-13T09:00:00.000Z'),
      ),
    ).toBe('2026-10-13T09:00:00.000Z');
  });

  test('nothing observed is null', () => {
    expect(lastActivity(fleet(null, null))).toBeNull();
  });
});
