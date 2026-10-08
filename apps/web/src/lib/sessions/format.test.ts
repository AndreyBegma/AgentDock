import { describe, expect, test } from 'bun:test';
import type {
  SessionSummary,
  SessionTotals,
  SessionTreeNode,
} from '@agentdock/shared';
import {
  barGeometry,
  buildTree,
  EMPTY_FILTERS,
  formatCost,
  formatDuration,
  formatTokens,
  liveTopicFor,
  queryString,
  sumTotals,
  tokenSum,
  toQuery,
} from './format';

const totals = (over: Partial<SessionTotals> = {}): SessionTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  reasoning: 0,
  requests: 0,
  costUsd: null,
  ...over,
});

const summary = (id: string): SessionSummary => ({
  id,
  runnerId: 'r',
  runtime: 'claude',
  profileKey: null,
  externalId: `ext-${id}`,
  projectId: 'p1',
  projectName: 'P',
  slotName: null,
  cwd: '/x',
  gitBranch: null,
  title: null,
  models: [],
  parentSessionId: null,
  parsed: true,
  startedAt: '2026-10-08T10:00:00.000Z',
  lastEventAt: '2026-10-08T10:01:00.000Z',
  endedAt: null,
  durationMs: 60_000,
  turns: 1,
  toolCalls: 1,
  subagents: 1,
  totals: totals(),
});

describe('formatters', () => {
  test('tokens', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1_234)).toBe('1.2k');
    expect(formatTokens(1_000)).toBe('1k');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });
  test('cost is blank until priced', () => {
    expect(formatCost(null)).toBe('—');
    expect(formatCost('0.004')).toBe('<$0.01');
    expect(formatCost('1.239')).toBe('$1.24');
  });
  test('duration', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(450)).toBe('450 ms');
    expect(formatDuration(65_000)).toBe('1m 5s');
    expect(formatDuration(3_900_000)).toBe('1h 5m');
  });
  test('reasoning is not added on top of output', () => {
    expect(tokenSum(totals({ input: 1, output: 10, reasoning: 4 }))).toBe(11);
  });
});

describe('query', () => {
  test('empty form → empty query string', () => {
    expect(queryString(toQuery(EMPTY_FILTERS))).toBe('');
  });
  test('unassigned wins over a project (the API rejects both)', () => {
    const q = toQuery({ ...EMPTY_FILTERS, projectId: 'p1', unassigned: true });
    expect(q).toEqual({ unassigned: true });
  });
  test('the end date is exclusive: the next local midnight', () => {
    const q = toQuery({ ...EMPTY_FILTERS, toDate: '2026-10-08' });
    expect(q.to).toBe(new Date(2026, 9, 9).toISOString());
  });
  test('cursor and limit are appended', () => {
    expect(
      queryString({ runtime: 'claude' }, { cursor: 'c1', limit: 50 }),
    ).toBe('?runtime=claude&cursor=c1&limit=50');
  });
});

describe('liveTopicFor', () => {
  test('project filter → project topic', () => {
    expect(liveTopicFor({ projectId: 'p1' })).toBe('project:p1');
  });
  test('unassigned → admin; nothing → poll', () => {
    expect(liveTopicFor({ unassigned: true })).toBe('admin');
    expect(liveTopicFor({})).toBeNull();
    expect(liveTopicFor({ projectId: null })).toBeNull();
  });
});

describe('buildTree', () => {
  const child: SessionTreeNode = {
    session: summary('child'),
    turns: [],
    unattributed: { requests: [], tools: [] },
    subagents: [],
    totals: totals({ input: 5, requests: 1 }),
  };
  const root: SessionTreeNode = {
    session: summary('root'),
    turns: [
      {
        id: 't1',
        promptId: 'pr1',
        startedAt: '2026-10-08T10:00:00.000Z',
        endedAt: null,
        requests: [
          {
            id: 'rq1',
            requestId: 'req1',
            ts: '2026-10-08T10:00:05.000Z',
            model: 'opus',
            querySource: 'main',
            durationMs: 2_000,
            durationApprox: false,
            stopReason: null,
            totals: totals({ input: 10, requests: 1 }),
          },
        ],
        tools: [
          {
            id: 'tc1',
            toolUseId: 'tu1',
            name: 'Task',
            startedAt: '2026-10-08T10:00:06.000Z',
            endedAt: null,
            ok: null,
            child,
            totals: child.totals,
          },
        ],
        totals: totals({ input: 15, requests: 2 }),
      },
    ],
    unattributed: { requests: [], tools: [] },
    subagents: [],
    totals: totals({ input: 15, requests: 2 }),
  };

  test('turns hold requests and tools; a spawning tool holds its child session', () => {
    const { items, info } = buildTree(root);
    const turn = items[0].children?.[0];
    expect(turn?.children?.map((c) => c.id)).toEqual([
      'request:rq1',
      'tool:tc1',
    ]);
    const tool = turn?.children?.[1];
    expect(tool?.children?.[0].id).toBe('session:child');
    expect(info.get('session:child')?.kind).toBe('session');
  });
  test('every id is unique', () => {
    const { info } = buildTree(root);
    expect(info.size).toBe(5);
  });
  test('a node with unattributed work gets a group', () => {
    const withLoose: SessionTreeNode = {
      ...root,
      unattributed: { requests: root.turns[0].requests, tools: [] },
    };
    const group = buildTree(withLoose).items[0].children?.at(-1);
    expect(group?.label).toBe('No turn known');
  });
});

describe('sumTotals / barGeometry', () => {
  test('sums buckets and cost; cost stays null when nothing is priced', () => {
    expect(
      sumTotals([totals({ input: 1 }), totals({ input: 2 })]).costUsd,
    ).toBeNull();
    expect(
      sumTotals([totals({ costUsd: '0.5' }), totals({ costUsd: '0.25' })])
        .costUsd,
    ).toBe('0.75');
  });
  test('bars are clamped and never vanish', () => {
    expect(barGeometry([0, 50], 0, 100)).toEqual({ left: 0, width: 50 });
    expect(barGeometry([40, 40], 0, 100).width).toBe(0.5);
    expect(barGeometry([150, 200], 0, 100)).toEqual({ left: 100, width: 0 });
  });
});
