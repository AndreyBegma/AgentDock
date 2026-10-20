import { WORKFLOW_AGENT_TYPE } from '@nautelle/shared';
import {
  erroredOf,
  orchestration,
  primaryAgentType,
  scope,
  summarize,
  toolTransitions,
  topAgentTypes,
  topToolFlow,
  type WorkflowGroup,
} from './workflow-metrics';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const MIN = 60_000;

/** One root session's group, or `sessions` alike ones (sums scale with it). */
const group = (
  over: Partial<WorkflowGroup> = {},
  sessions = 1,
): WorkflowGroup => ({
  runtime: 'claude',
  agentType: WORKFLOW_AGENT_TYPE.none,
  bucket: 'none',
  outcome: 'completed',
  sessions,
  depth: 0,
  subagents: 0,
  compactions: 0,
  durationMs: 0,
  ...over,
});

describe('erroredOf', () => {
  const t = (s: number) => new Date(NOW.getTime() + s * 1000);

  it('holds when no request came after the last error', () => {
    expect(erroredOf(t(10), t(5))).toBe(true);
    expect(erroredOf(t(10), null)).toBe(true);
    expect(erroredOf(t(10), t(10))).toBe(true);
  });

  it('clears when a request succeeded after it, and needs an error at all', () => {
    expect(erroredOf(t(10), t(11))).toBe(false);
    expect(erroredOf(null, t(11))).toBe(false);
  });
});

describe('primaryAgentType', () => {
  it('is none without subagents, unknown when no type is known', () => {
    expect(primaryAgentType([])).toBe(WORKFLOW_AGENT_TYPE.none);
    expect(primaryAgentType([null, null])).toBe(WORKFLOW_AGENT_TYPE.unknown);
  });

  it('is the most common known type, ties to the first name', () => {
    expect(primaryAgentType(['Plan', 'Explore', null, 'Explore'])).toBe(
      'Explore',
    );
    expect(primaryAgentType(['Plan', 'Explore'])).toBe('Explore');
  });
});

describe('topAgentTypes', () => {
  it('keeps the eight most common names by sessions, never a pseudo type', () => {
    const groups = [
      ...Array.from({ length: 10 }, (_, i) =>
        group({ agentType: `t${i}` }, 10 - i),
      ),
      group({ agentType: WORKFLOW_AGENT_TYPE.none }, 50),
      group({ agentType: WORKFLOW_AGENT_TYPE.unknown }, 50),
    ];
    expect([...topAgentTypes(groups)].sort()).toEqual(
      ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7'].sort(),
    );
  });

  it('sums a type over its groups', () => {
    const groups = [
      ...Array.from({ length: 8 }, (_, i) => group({ agentType: `t${i}` }, 2)),
      group({ agentType: 'split', outcome: 'error' }, 2),
      group({ agentType: 'split', outcome: 'completed' }, 1),
    ];
    expect(topAgentTypes(groups).has('split')).toBe(true);
  });
});

describe('scope', () => {
  const active = group({ outcome: 'active' });
  const done = group();
  const failed = group({ outcome: 'error', bucket: 'many', compactions: 2 });
  const groups = [active, done, failed];

  it('filters on status: active, ended, all', () => {
    expect(scope(groups, { status: 'active' })).toEqual([active]);
    expect(scope(groups, { status: 'ended' })).toEqual([done, failed]);
    expect(scope(groups, { status: 'all' })).toEqual(groups);
    expect(scope(groups, {})).toEqual(groups);
  });

  it('filters on the node filters: outcome, compactions, agentType', () => {
    expect(scope(groups, { outcome: 'error' })).toEqual([failed]);
    expect(scope(groups, { compactions: 'many' })).toEqual([failed]);
    expect(scope(groups, { agentType: WORKFLOW_AGENT_TYPE.none })).toEqual(
      groups,
    );
    expect(scope(groups, { agentType: 'Explore' })).toEqual([]);
  });

  it('reads agentType=~other as the types outside the top of the scope', () => {
    const many = [
      ...Array.from({ length: 8 }, (_, i) =>
        group({ agentType: `top${i}` }, 3),
      ),
      group({ agentType: 'rare' }),
      group({ agentType: 'rarer' }),
      group({ agentType: WORKFLOW_AGENT_TYPE.unknown }),
    ];
    const other = scope(many, { agentType: WORKFLOW_AGENT_TYPE.other });
    expect(other.map((g) => g.agentType).sort()).toEqual(['rare', 'rarer']);
  });

  it('decides the top types after the other filters', () => {
    const many = [
      ...Array.from({ length: 8 }, (_, i) =>
        group({ agentType: `top${i}`, outcome: 'active' }, 5),
      ),
      group({ agentType: 'onlyEnded', outcome: 'completed' }),
    ];
    // Among ended sessions alone, `onlyEnded` is a top type, not "+N more".
    expect(
      scope(many, { status: 'ended', agentType: WORKFLOW_AGENT_TYPE.other }),
    ).toEqual([]);
  });
});

describe('summarize', () => {
  it('averages over sessions and rates success as completed / ended', () => {
    const groups = [
      group({
        depth: 2,
        subagents: 3,
        compactions: 1,
        bucket: 'one',
        durationMs: 60 * MIN,
      }),
      group({ outcome: 'error', durationMs: 20 * MIN }),
      group({ outcome: 'abandoned', durationMs: 10 * MIN }),
      group({ outcome: 'active', durationMs: 10 * MIN }),
    ];
    const flow = { from: 'Bash', to: 'Edit', count: 7 };
    expect(summarize(groups, flow, NOW)).toEqual({
      sessions: 4,
      active: 1,
      ended: 3,
      outcomes: { completed: 1, error: 1, abandoned: 1, active: 1 },
      avgDepth: 0.5,
      avgSubagents: 0.75,
      // Abandoned is not a success: 1 completed of 3 ended.
      successRate: 1 / 3,
      topToolFlow: flow,
      avgCompactions: 0.25,
      avgDurationMs: (100 * MIN) / 4,
      computedAt: NOW.toISOString(),
    });
  });

  it('weights a group by its sessions', () => {
    const result = summarize(
      [group({ depth: 9, subagents: 9 }, 3), group({ outcome: 'error' }, 1)],
      null,
      NOW,
    );
    expect(result).toMatchObject({
      sessions: 4,
      avgDepth: 9 / 4,
      successRate: 3 / 4,
    });
  });

  it('says null, never zero, when there is nothing to average', () => {
    expect(summarize([], null, NOW)).toMatchObject({
      sessions: 0,
      avgDepth: null,
      avgSubagents: null,
      successRate: null,
      avgCompactions: null,
      avgDurationMs: null,
      topToolFlow: null,
    });
    const onlyActive = summarize([group({ outcome: 'active' })], null, NOW);
    expect(onlyActive.successRate).toBeNull();
    expect(onlyActive.avgDepth).toBe(0);
  });
});

describe('orchestration', () => {
  const groups = [
    group({ agentType: 'Explore', subagents: 3, depth: 2 }, 1),
    group({ agentType: 'Explore', bucket: 'one', compactions: 1 }, 1),
    group({ outcome: 'error' }, 1),
    group({ runtime: 'codex', outcome: 'active', bucket: 'many' }, 1),
  ];
  const graph = orchestration(groups, NOW);

  it('has the five columns, and every column sums to the session count', () => {
    expect(graph.columns.map((c) => c.id)).toEqual([
      'origin',
      'agent',
      'subagentType',
      'compactions',
      'outcome',
    ]);
    for (const column of graph.columns) {
      const total = graph.nodes
        .filter((node) => node.column === column.id)
        .reduce((sum, node) => sum + node.value, 0);
      expect(total).toBe(4);
    }
    expect(graph.sessions).toBe(4);
  });

  it('conserves flow: every inner node takes in what it sends on', () => {
    for (const node of graph.nodes) {
      if (node.column === 'origin' || node.column === 'outcome') continue;
      const sum = (key: 'source' | 'target') =>
        graph.links
          .filter((l) => l[key] === node.id)
          .reduce((s, l) => s + l.value, 0);
      expect({ id: node.id, inflow: sum('target') }).toEqual({
        id: node.id,
        inflow: node.value,
      });
      expect({ id: node.id, outflow: sum('source') }).toEqual({
        id: node.id,
        outflow: node.value,
      });
    }
  });

  it('gives each node the filter a click applies', () => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get('origin')?.filter).toBeNull();
    expect(byId.get('agent:codex')).toMatchObject({
      label: 'Codex',
      filter: { key: 'runtime', value: 'codex' },
      value: 1,
    });
    expect(byId.get('type:Explore')).toMatchObject({
      label: 'Explore',
      filter: { key: 'agentType', value: 'Explore' },
      value: 2,
    });
    expect(byId.get('type:~none')).toMatchObject({
      label: 'No subagents',
      value: 2,
    });
    expect(byId.get('compactions:many')?.filter).toEqual({
      key: 'compactions',
      value: 'many',
    });
    expect(byId.get('outcome:active')?.value).toBe(1);
    expect(byId.get('outcome:error')?.value).toBe(1);
    expect(byId.has('outcome:abandoned')).toBe(false);
  });

  it('orders compactions and outcomes as listed, types by size with pseudo types last', () => {
    const ids = graph.nodes.map((n) => n.id);
    expect(ids.filter((id) => id.startsWith('compactions:'))).toEqual([
      'compactions:none',
      'compactions:one',
      'compactions:many',
    ]);
    expect(ids.filter((id) => id.startsWith('outcome:'))).toEqual([
      'outcome:completed',
      'outcome:error',
      'outcome:active',
    ]);
    expect(ids.filter((id) => id.startsWith('type:'))).toEqual([
      'type:Explore',
      'type:~none',
    ]);
  });

  it('folds the types past the top eight into "+N more"', () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      group({ agentType: `type${i}` }),
    );
    const folded = orchestration(many, NOW);
    expect(folded.nodes.find((n) => n.id === 'type:~other')).toMatchObject({
      label: '+3 more',
      folded: 3,
      value: 3,
      filter: { key: 'agentType', value: '~other' },
    });
    expect(
      folded.nodes.filter((n) => n.column === 'subagentType'),
    ).toHaveLength(9);
  });

  it('is empty, with its columns, for no session', () => {
    expect(orchestration([], NOW)).toMatchObject({
      sessions: 0,
      nodes: [],
      links: [],
    });
  });
});

describe('tool transitions', () => {
  const sums = [
    { from: 'Read', to: 'Edit', count: 4, errors: 1 },
    { from: 'Bash', to: 'Edit', count: 9, errors: 0 },
    { from: 'Bash', to: 'Bash', count: 4, errors: 4 },
  ];

  it('orders by count, then names, with the error share', () => {
    expect(toolTransitions(sums, 2)).toEqual([
      { from: 'Bash', to: 'Edit', count: 9, errors: 0, errorShare: 0 },
      { from: 'Bash', to: 'Bash', count: 4, errors: 4, errorShare: 1 },
    ]);
  });

  it('names the top bigram, or null without transitions', () => {
    expect(topToolFlow(sums)).toEqual({ from: 'Bash', to: 'Edit', count: 9 });
    expect(topToolFlow([])).toBeNull();
  });
});
