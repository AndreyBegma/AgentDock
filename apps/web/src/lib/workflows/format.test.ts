import { describe, expect, test } from 'bun:test';
import type {
  WorkflowSankeyNode,
  WorkflowsOrchestrationResponse,
  WorkflowsSummaryResponse,
} from '@agentdock/shared';
import { ApiError } from '../api';
import { exportFileName, orchestrationCsv, summaryCsv, toCsv } from './export';
import {
  applyNodeFilter,
  DEFAULT_WORKFLOWS_FILTERS,
  describeWorkflowsError,
  filtersFromSearch,
  filtersSearch,
  formatAverage,
  formatAverageDuration,
  formatFlow,
  formatRate,
  formatUpdatedAt,
  hasNodeFilters,
  nodeFilterChips,
  rangeOf,
  STATUS_LABEL,
  WORKFLOWS_FILTER_CODEC,
  type WorkflowsFilters,
  workflowsChipDefs,
  workflowsQuery,
} from './format';
import { orchestrationNodeLook, toolLabel, toolSankey } from './sankey';

const parse = (search: string) =>
  filtersFromSearch(new URLSearchParams(search));

const filters = (over: Partial<WorkflowsFilters> = {}): WorkflowsFilters => ({
  ...DEFAULT_WORKFLOWS_FILTERS,
  ...over,
});

const node = (filter: WorkflowSankeyNode['filter']): WorkflowSankeyNode => ({
  id: 'x',
  label: 'x',
  column: 'outcome',
  value: 1,
  filter,
});

describe('filtersFromSearch / filtersSearch', () => {
  test('an empty URL is the defaults, and the defaults are an empty URL', () => {
    expect(parse('')).toEqual(DEFAULT_WORKFLOWS_FILTERS);
    expect(filtersSearch(DEFAULT_WORKFLOWS_FILTERS)).toBe('');
  });

  test('every filter round-trips through the URL', () => {
    const all = filters({
      range: '30d',
      projectId: 'p1',
      profileKey: 'work',
      status: 'ended',
      runtime: 'claude',
      agentType: 'Explore',
      compactions: 'many',
      outcome: 'error',
    });
    expect(parse(filtersSearch(all))).toEqual(all);
  });

  test('from and to make a custom range, whatever range says', () => {
    const parsed = parse('range=24h&from=2026-10-01&to=2026-10-07');
    expect(parsed.range).toBe('custom');
    expect(parsed.fromDate).toBe('2026-10-01');
    expect(filtersSearch(parsed)).toBe('?from=2026-10-01&to=2026-10-07');
  });

  test('a custom range still being picked keeps range=custom', () => {
    const half = filters({ range: 'custom', fromDate: '2026-10-01' });
    expect(filtersSearch(half)).toBe('?from=2026-10-01&range=custom');
    expect(parse('range=custom').range).toBe('custom');
  });

  test('unknown values are dropped, not sent to the API', () => {
    const parsed = parse(
      'range=1y&status=done&runtime=gpt&compactions=3&outcome=ok&from=yesterday&to=2026-10-07',
    );
    expect(parsed).toEqual(DEFAULT_WORKFLOWS_FILTERS);
  });

  test('an agent type over the contract length is dropped', () => {
    expect(parse(`agentType=${'a'.repeat(201)}`).agentType).toBe('');
    expect(parse('agentType=~other').agentType).toBe('~other');
  });
});

describe('rangeOf / workflowsQuery', () => {
  test('a preset ends at the next hour and spans its length', () => {
    const range = rangeOf(
      filters({ range: '24h' }),
      new Date('2026-10-14T10:20:00Z'),
    );
    expect(range).toEqual({
      from: '2026-10-13T11:00:00.000Z',
      to: '2026-10-14T11:00:00.000Z',
    });
  });

  test('an incomplete custom range is no range', () => {
    expect(rangeOf(filters({ range: 'custom', fromDate: '2026-10-01' }))).toBe(
      null,
    );
  });

  test('the query carries the range and only the filters that are set', () => {
    const range = { from: 'F', to: 'T' };
    expect(workflowsQuery(filters(), range)).toBe('?from=F&to=T');
    expect(
      workflowsQuery(
        filters({ projectId: 'p1', status: 'active', agentType: '~none' }),
        range,
        { limit: 20 },
      ),
    ).toBe(
      '?from=F&to=T&projectId=p1&status=active&agentType=%7Enone&limit=20',
    );
  });
});

describe('applyNodeFilter', () => {
  test('a node sets its filter, the others stay', () => {
    const next = applyNodeFilter(
      filters({ outcome: 'error' }),
      node({ key: 'agentType', value: 'Explore' }),
    );
    expect(next.agentType).toBe('Explore');
    expect(next.outcome).toBe('error');
  });

  test('the node already filtered on clears it again', () => {
    const next = applyNodeFilter(
      filters({ compactions: 'one' }),
      node({ key: 'compactions', value: 'one' }),
    );
    expect(next.compactions).toBe('');
  });

  test('another value of the same key replaces it', () => {
    const next = applyNodeFilter(
      filters({ outcome: 'error' }),
      node({ key: 'outcome', value: 'completed' }),
    );
    expect(next.outcome).toBe('completed');
  });

  test('the origin node clears every node filter, never the page filters', () => {
    const next = applyNodeFilter(
      filters({
        projectId: 'p1',
        status: 'ended',
        runtime: 'codex',
        agentType: '~other',
        compactions: 'many',
        outcome: 'abandoned',
      }),
      node(null),
    );
    expect(hasNodeFilters(next)).toBe(false);
    expect(next.projectId).toBe('p1');
    expect(next.status).toBe('ended');
  });
});

describe('labels', () => {
  test('the third status is "Ended", not a second "Completed"', () => {
    expect(STATUS_LABEL.ended).toBe('Ended');
  });

  test('chips name each node filter in words, in a fixed order', () => {
    expect(
      nodeFilterChips(
        filters({ outcome: 'error', agentType: '~unknown', runtime: 'claude' }),
      ).map((chip) => chip.label),
    ).toEqual([
      'Main agent: Claude Code',
      'Subagent type: Unknown type',
      'Outcome: Error',
    ]);
  });
});

describe('tile formatting', () => {
  test('null is "—", never 0', () => {
    expect(formatAverage(null)).toBe('—');
    expect(formatRate(null)).toBe('—');
    expect(formatFlow(null)).toBe('—');
    expect(formatAverageDuration(null)).toBe('—');
  });

  test('a real zero is a zero', () => {
    expect(formatAverage(0)).toBe('0.0');
    expect(formatRate(0)).toBe('0%');
  });

  test('averages keep their decimal, so 0.0 sits beside 0.3 (#213)', () => {
    expect(formatAverage(0.04)).toBe('0.0');
    expect(formatAverage(0.3)).toBe('0.3');
    expect(formatAverage(2)).toBe('2.0');
    expect(formatAverage(1234.56)).toBe('1,234.6');
  });

  test('"Updated hh:mm", no seconds', () => {
    const at = new Date(2026, 9, 14, 9, 4, 7).toISOString();
    expect(formatUpdatedAt(at)).toBe('09:04');
    expect(formatUpdatedAt('not a date')).toBe('');
  });

  test('averages, rates, flows and durations', () => {
    expect(formatAverage(1.26)).toBe('1.3');
    expect(formatRate(0.875)).toBe('87.5%');
    expect(formatRate(1)).toBe('100%');
    expect(formatFlow({ from: 'Bash', to: 'Edit', count: 3 })).toBe(
      'Bash → Edit',
    );
    expect(formatAverageDuration(12_400)).toBe('12 s');
    expect(formatAverageDuration(1_382_000)).toBe('23 min');
    expect(formatAverageDuration(7_620_000)).toBe('2 h 07 min');
  });
});

describe('orchestrationNodeLook', () => {
  test('outcomes wear their state, the ~ buckets stay neutral', () => {
    expect(
      orchestrationNodeLook(node({ key: 'outcome', value: 'error' })),
    ).toEqual({ tone: 'danger' });
    expect(
      orchestrationNodeLook(node({ key: 'agentType', value: '~none' })),
    ).toEqual({ tone: 'neutral' });
    expect(orchestrationNodeLook(node(null))).toEqual({ tone: 'neutral' });
  });

  test('a named type keeps one hue on every render', () => {
    const a = orchestrationNodeLook(
      node({ key: 'agentType', value: 'Explore' }),
    );
    const b = orchestrationNodeLook(
      node({ key: 'agentType', value: 'Explore' }),
    );
    expect(a.hue).toBeDefined();
    expect(a).toEqual(b);
  });
});

describe('toolSankey', () => {
  test('a self-loop and a cycle draw left to right, one node per side', () => {
    const graph = toolSankey([
      { from: 'Bash', to: 'Bash', count: 5, errors: 1, errorShare: 0.2 },
      { from: 'Bash', to: 'Edit', count: 3, errors: 0, errorShare: 0 },
      { from: 'Edit', to: 'Bash', count: 2, errors: 0, errorShare: 0 },
    ]);
    expect(graph.columns.map((c) => c.id)).toEqual(['from', 'to']);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual([
      'from:Bash',
      'from:Edit',
      'to:Bash',
      'to:Edit',
    ]);
    expect(graph.links).toContainEqual({
      source: 'from:Bash',
      target: 'to:Bash',
      value: 5,
    });
    for (const link of graph.links) {
      expect(link.source.startsWith('from:')).toBe(true);
      expect(link.target.startsWith('to:')).toBe(true);
    }
    const hue = (id: string) => graph.nodes.find((n) => n.id === id)?.hue;
    expect(hue('from:Bash')).toBe(hue('to:Bash'));
  });

  test('an MCP tool is labelled short; the id keeps the full name', () => {
    const tool = 'mcp__plugin_playwright_playwright__browser_navigate';
    const graph = toolSankey([
      { from: tool, to: 'Bash', count: 1, errors: 0, errorShare: 0 },
    ]);
    const source = graph.nodes.find((n) => n.id === `from:${tool}`);
    expect(source?.label).toBe('playwright · browser_navigate');
  });
});

describe('toolLabel', () => {
  test('a built-in tool is its own name', () => {
    expect(toolLabel('Bash')).toBe('Bash');
  });

  test('an MCP tool reads server · tool', () => {
    expect(toolLabel('mcp__glitchtip__list_issues')).toBe(
      'glitchtip · list_issues',
    );
    expect(toolLabel('mcp__claude_ai_Google_Drive__search')).toBe(
      'claude_ai_Google_Drive · search',
    );
  });

  test("a plugin's repeated server name is said once", () => {
    expect(toolLabel('mcp__plugin_context7_context7__query-docs')).toBe(
      'context7 · query-docs',
    );
  });
});

describe('filters in the URL and chips', () => {
  test('the codec owns every key the page writes', () => {
    const search = filtersSearch(
      filters({
        range: 'custom',
        fromDate: '2026-10-01',
        projectId: 'p1',
        profileKey: 'k',
        status: 'ended',
        runtime: 'claude',
        agentType: 'Explore',
        compactions: 'one',
        outcome: 'error',
      }),
    );
    for (const key of new URLSearchParams(search).keys()) {
      expect(WORKFLOWS_FILTER_CODEC.keys).toContain(key);
    }
  });

  test('project, profile and graph filters are chips; range and status are not', () => {
    const defs = workflowsChipDefs({
      project: () => 'Alpha',
      profile: () => 'Opus fast',
    });
    const set = filters({
      range: '30d',
      status: 'ended',
      projectId: 'p1',
      profileKey: 'k',
      outcome: 'error',
    });
    expect(defs.flatMap((d) => d.label(set) ?? [])).toEqual([
      'Project: Alpha',
      'Runtime profile: Opus fast',
      'Outcome: Error',
    ]);
    expect(defs.find((d) => d.key === 'projectId')?.clear).toEqual({
      projectId: '',
      profileKey: '',
    });
  });
});

describe('export', () => {
  test('CSV quotes what needs it and defuses formulas', () => {
    expect(toCsv([['a,b', 'say "hi"', 3, null, '=SUM(A1)']])).toBe(
      `"a,b","say ""hi""",3,,'=SUM(A1)\r\n`,
    );
  });

  test('the summary CSV keeps a null blank, never 0', () => {
    const summary: WorkflowsSummaryResponse = {
      sessions: 0,
      active: 0,
      ended: 0,
      outcomes: { completed: 0, error: 0, abandoned: 0, active: 0 },
      avgDepth: null,
      avgSubagents: null,
      successRate: null,
      topToolFlow: null,
      avgCompactions: null,
      avgDurationMs: null,
      computedAt: '2026-10-14T10:00:00.000Z',
    };
    const csv = summaryCsv(summary);
    expect(csv).toContain('success_rate,\r\n');
    expect(csv).toContain('sessions,0\r\n');
  });

  test('orchestration rows name both ends by label and column', () => {
    const data: WorkflowsOrchestrationResponse = {
      sessions: 2,
      columns: [],
      nodes: [
        {
          id: 'origin',
          label: 'Sessions',
          column: 'origin',
          value: 2,
          filter: null,
        },
        {
          id: 'agent:claude',
          label: 'Claude Code',
          column: 'agent',
          value: 2,
          filter: { key: 'runtime', value: 'claude' },
        },
      ],
      links: [{ source: 'origin', target: 'agent:claude', value: 2 }],
      computedAt: '',
    };
    expect(orchestrationCsv(data).split('\r\n')[1]).toBe(
      'origin,Sessions,agent,Claude Code,2',
    );
  });

  test('the file name carries the range', () => {
    expect(
      exportFileName(
        'tools',
        { from: '2026-10-07T00:00:00.000Z', to: '2026-10-14T00:00:00.000Z' },
        'csv',
      ),
    ).toBe('workflows-tools-2026-10-07-to-2026-10-14.csv');
  });
});

describe('describeWorkflowsError', () => {
  test('a hidden project is not found; a bad range says why', () => {
    expect(describeWorkflowsError(new ApiError(404, undefined, 'x'))).toContain(
      'not a member',
    );
    expect(
      describeWorkflowsError(
        new ApiError(400, undefined, 'The range is longer than 400 days.'),
      ),
    ).toBe('The range is longer than 400 days.');
    expect(describeWorkflowsError(new Error('net'))).toBe(
      'Could not reach the server.',
    );
  });
});
