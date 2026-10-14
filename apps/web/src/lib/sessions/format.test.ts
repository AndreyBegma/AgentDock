import { describe, expect, test } from 'bun:test';
import type {
  SessionSummary,
  SessionToolNode,
  SessionTotals,
  SessionTreeNode,
} from '@agentdock/shared';
import {
  appliedFilterCount,
  buildTrace,
  describeSessionHint,
  EMPTY_FILTERS,
  formatCost,
  formatDuration,
  formatTokens,
  hasSessionFilters,
  liveTopicFor,
  originOf,
  queryString,
  sessionFormChanged,
  sumTotals,
  tokenSum,
  toQuery,
  totalsLabel,
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
    expect(formatDuration(65_000)).toBe('1 min 05 s');
    expect(formatDuration(3_900_000)).toBe('1 h 05 min');
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
  test('the origin filter is sent as `origin`', () => {
    const q = toQuery({ ...EMPTY_FILTERS, origin: 'manual' });
    expect(queryString(q)).toBe('?origin=manual');
    expect(appliedFilterCount(q)).toBe(1);
  });
  test('an absent origin reads as unknown', () => {
    expect(originOf({})).toBe('unknown');
    expect(originOf({ origin: 'worker' })).toBe('worker');
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

describe('buildTrace', () => {
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
    const { nodes, info } = buildTrace(root);
    expect(nodes[0]).toMatchObject({ kind: 'agent', status: 'running' });
    const turn = nodes[0].children?.[0];
    expect(turn?.kind).toBe('turn');
    expect(turn?.children?.map((c) => [c.id, c.kind])).toEqual([
      ['request:rq1', 'llm'],
      ['tool:tc1', 'tool'],
    ]);
    const request = turn?.children?.[0];
    expect(request).toMatchObject({
      label: 'opus',
      meta: 'main thread',
      start: Date.parse('2026-10-08T10:00:03.000Z'),
      end: Date.parse('2026-10-08T10:00:05.000Z'),
    });
    const tool = turn?.children?.[1];
    expect(tool?.children?.[0]).toMatchObject({
      id: 'session:child',
      kind: 'agent',
    });
    expect(info.get('session:child')?.kind).toBe('session');
  });
  test('every id is unique', () => {
    const { info } = buildTrace(root);
    expect(info.size).toBe(5);
  });
  test('a node with unattributed work gets an `other` group spanning it', () => {
    const withLoose: SessionTreeNode = {
      ...root,
      unattributed: { requests: root.turns[0].requests, tools: [] },
    };
    const group = buildTrace(withLoose).nodes[0].children?.at(-1);
    expect(group).toMatchObject({
      label: 'No turn known',
      kind: 'other',
      start: Date.parse('2026-10-08T10:00:03.000Z'),
      end: Date.parse('2026-10-08T10:00:05.000Z'),
    });
  });
  test('requests and tools interleave by start time', () => {
    const turn = root.turns[0];
    const early: SessionToolNode = {
      ...(turn.tools[0] as SessionToolNode),
      id: 'tc0',
      child: null,
      startedAt: '2026-10-08T10:00:01.000Z',
      endedAt: '2026-10-08T10:00:02.000Z',
      ok: true,
    };
    const interleaved: SessionTreeNode = {
      ...root,
      turns: [{ ...turn, tools: [...turn.tools, early] }],
    };
    const children = buildTrace(interleaved).nodes[0].children?.[0].children;
    expect(children?.map((c) => c.id)).toEqual([
      'tool:tc0',
      'request:rq1',
      'tool:tc1',
    ]);
  });
  test('a failed tool is an error; a pending one runs only while the session does', () => {
    const tool = (over: Partial<SessionToolNode>, endedAt: string | null) => {
      const node: SessionTreeNode = {
        ...root,
        session: { ...root.session, endedAt },
        turns: [
          {
            ...root.turns[0],
            requests: [],
            tools: [
              { ...(root.turns[0].tools[0] as SessionToolNode), ...over },
            ],
          },
        ],
      };
      return buildTrace(node).nodes[0].children?.[0].children?.[0];
    };
    expect(tool({ ok: false, child: null }, null)?.status).toBe('error');
    expect(tool({ ok: null, child: null }, null)).toMatchObject({
      status: 'running',
      end: undefined,
    });
    const settled = tool({ ok: null, child: null }, '2026-10-08T10:01:00Z');
    expect(settled?.status).toBeUndefined();
    expect(settled?.end).toBe(settled?.start);
  });
  test('totals carry the cost only once it is priced', () => {
    expect(totalsLabel(totals({ input: 1_500 }))).toBe('1.5k tok');
    expect(totalsLabel(totals({ input: 10, costUsd: '0.42' }))).toBe(
      '10 tok · $0.42',
    );
  });
});

describe('sumTotals', () => {
  test('sums buckets and cost; cost stays null when nothing is priced', () => {
    expect(
      sumTotals([totals({ input: 1 }), totals({ input: 2 })]).costUsd,
    ).toBeNull();
    expect(
      sumTotals([totals({ costUsd: '0.5' }), totals({ costUsd: '0.25' })])
        .costUsd,
    ).toBe('0.75');
  });
});

describe('appliedFilterCount', () => {
  test('a date range counts once; empty values do not count', () => {
    expect(appliedFilterCount({})).toBe(0);
    expect(
      appliedFilterCount({ from: 'a', to: 'b', runtime: 'claude', model: '' }),
    ).toBe(2);
    expect(appliedFilterCount({ to: 'b', unassigned: true, slot: 'i4' })).toBe(
      3,
    );
  });
});

describe('filters and hints', () => {
  test('a query with no value is not a filter', () => {
    expect(hasSessionFilters({})).toBe(false);
    expect(hasSessionFilters({ model: 'x' })).toBe(true);
  });

  test('a form differing from what was applied is changed', () => {
    expect(sessionFormChanged(EMPTY_FILTERS, {})).toBe(false);
    expect(sessionFormChanged({ ...EMPTY_FILTERS, slot: ' i42 ' }, {})).toBe(
      true,
    );
    expect(
      sessionFormChanged({ ...EMPTY_FILTERS, slot: 'i42' }, { slot: 'i42' }),
    ).toBe(false);
  });

  test('a failure without a fix is just text', () => {
    expect(describeSessionHint(new Error('x'))).toEqual({
      text: 'Could not reach the server.',
    });
  });
});
