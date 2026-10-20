import { describe, expect, it } from 'bun:test';
import {
  buildFleetGraph,
  type FleetGraphIssueInput,
  type FleetGraphSlotInput,
  type FleetSlotNode,
  pillOf,
  progressOf,
  type SlotStageInput,
  stageOf,
} from './index';

const stage = (over: Partial<SlotStageInput> = {}): SlotStageInput => ({
  status: 'running',
  lastCheckpoint: null,
  checkpoints: [],
  prNumber: null,
  prState: null,
  prChecks: null,
  ...over,
});

describe('stageOf / progressOf', () => {
  it.each([
    [stage(), null, 0],
    [stage({ checkpoints: ['picked_up'] }), 'picked_up', 10],
    [stage({ checkpoints: ['picked_up', 'plan_ready'] }), 'plan_ready', 25],
    [
      stage({
        checkpoints: ['implementation_done'],
        lastCheckpoint: 'blocked',
      }),
      'implementation_done',
      60,
    ],
    [
      stage({ prNumber: 7, prState: 'open', prChecks: 'pending' }),
      'pr_open',
      80,
    ],
    [stage({ prNumber: 7, prState: 'open', prChecks: 'red' }), 'pr_open', 80],
    [
      stage({ prNumber: 7, prState: 'open', prChecks: 'green' }),
      'checks_green',
      90,
    ],
    [stage({ prNumber: 7, prState: 'merged' }), 'merged', 100],
  ] as const)('%#: %o → %s (%d)', (input, expected, progress) => {
    expect(stageOf(input)).toBe(expected);
    expect(progressOf(stageOf(input))).toBe(progress);
  });

  it('never sets a run back: a closed PR keeps the furthest checkpoint', () => {
    expect(
      stageOf(
        stage({
          prNumber: 7,
          prState: 'closed',
          prChecks: 'green',
          checkpoints: ['plan_ready'],
        }),
      ),
    ).toBe('plan_ready');
  });
});

describe('pillOf', () => {
  it.each([
    [stage({ status: 'running' }), 'running'],
    [stage({ status: 'dispatched' }), 'waiting'],
    [stage({ status: 'idle' }), 'waiting'],
    [stage({ status: 'prompt' }), 'waiting'],
    [stage({ status: 'quota' }), 'paused'],
    [stage({ status: 'stale' }), 'paused'],
    [stage({ status: 'running', lastCheckpoint: 'blocked' }), 'blocked'],
    [stage({ status: 'idle', lastCheckpoint: 'misclassified' }), 'blocked'],
    [stage({ status: 'idle', prChecks: 'red' }), 'blocked'],
    [stage({ status: 'idle', prState: 'merged' }), 'done'],
    [stage({ status: 'ended' }), 'done'],
  ] as const)('%#: → %s', (input, pill) => {
    expect(pillOf(input)).toBe(pill);
  });
});

const slot = (
  name: string,
  over: Partial<FleetGraphSlotInput> = {},
): FleetGraphSlotInput => ({
  ...stage(),
  id: `id_${name}`,
  name,
  issue: Number(/^i(\d+)/.exec(name)?.[1]) || null,
  runtime: 'claude',
  model: 'opus',
  modelWhy: null,
  lead: null,
  branch: `feat/${name}`,
  round: '2026-10-14/0900',
  prUrl: null,
  startedAt: '2026-10-14T09:00:00.000Z',
  updatedAt: '2026-10-14T09:00:00.000Z',
  ...over,
});

const plan = (rows: string[][]) =>
  [
    '## Parallel plan',
    '| Slot | Owns | Depends on | Lead | Model |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');

const graph = (
  slots: FleetGraphSlotInput[],
  issues: FleetGraphIssueInput[] = [],
) =>
  buildFleetGraph({
    projectId: 'prj_1',
    orchestrator: {
      status: 'running',
      session: 'nautelle-orch-x',
      since: null,
    },
    slots,
    issues,
    generatedAt: '2026-10-14T10:00:00.000Z',
  });

const edgeList = (g: ReturnType<typeof graph>) =>
  g.edges.map((e) => `${e.from} -${e.kind}-> ${e.to}`);

describe('buildFleetGraph', () => {
  it('hangs unrelated slots off the orchestrator', () => {
    const g = graph([slot('i1'), slot('i2'), slot('chore-x')]);
    expect(g.nodes.map((n) => n.id)).toEqual([
      'orchestrator',
      'slot:i1',
      'slot:i2',
      'slot:chore-x',
    ]);
    expect(edgeList(g)).toEqual([
      'orchestrator -delegates-> slot:i1',
      'orchestrator -delegates-> slot:i2',
      'orchestrator -delegates-> slot:chore-x',
    ]);
    expect(g.nodes[0]).toMatchObject({ kind: 'orchestrator', pill: 'running' });
  });

  it('draws a wave: lead → siblings, Depends on → dependants, planned siblings included', () => {
    const body = plan([
      ['i160-data', 'shared', '—', 'yes', 'opus'],
      ['i160-canvas', 'web', 'i160-data', 'no', 'opus'],
      ['i160-panel', 'web', 'i160-data, i160-canvas', 'no', 'sonnet'],
      ['i160-docs', 'docs', '—', 'no', 'haiku'],
    ]);
    const g = graph(
      [
        slot('i160-data', {
          lead: true,
          checkpoints: ['picked_up', 'plan_ready'],
          lastCheckpoint: 'plan_ready',
        }),
      ],
      [{ number: 160, title: 'Agent workspace', body }],
    );
    expect(g.nodes.map((n) => [n.id, n.kind])).toEqual([
      ['orchestrator', 'orchestrator'],
      ['slot:i160-data', 'slot'],
      ['slot:i160-canvas', 'planned'],
      ['slot:i160-panel', 'planned'],
      ['slot:i160-docs', 'planned'],
    ]);
    expect(edgeList(g)).toEqual([
      'slot:i160-data -depends_on-> slot:i160-canvas',
      'slot:i160-data -depends_on-> slot:i160-panel',
      'slot:i160-canvas -depends_on-> slot:i160-panel',
      'slot:i160-data -lead-> slot:i160-docs',
      'orchestrator -delegates-> slot:i160-data',
    ]);
    const data = g.nodes[1] as FleetSlotNode;
    expect(data).toMatchObject({
      slotId: 'id_i160-data',
      issueTitle: 'Agent workspace',
      stage: 'plan_ready',
      progress: 25,
      pill: 'running',
      branch: 'feat/i160-data',
    });
    expect(g.nodes[3]).toMatchObject({
      kind: 'planned',
      model: 'sonnet',
      pill: 'waiting',
      progress: 0,
      stage: null,
    });
  });

  it('uses Slot.lead when the issue has no plan', () => {
    const g = graph([
      slot('i9-api', { lead: true }),
      slot('i9-web', { lead: false }),
    ]);
    expect(edgeList(g)).toEqual([
      'slot:i9-api -lead-> slot:i9-web',
      'orchestrator -delegates-> slot:i9-api',
    ]);
  });

  it('links issues by Depends on #m, root to root', () => {
    const g = graph(
      [slot('i5'), slot('i6'), slot('i7')],
      [
        { number: 5, title: 'five', body: 'x' },
        { number: 6, title: 'six', body: 'Depends on #5\nDepends on #99' },
        { number: 7, title: 'seven', body: 'nothing' },
      ],
    );
    expect(edgeList(g)).toEqual([
      'slot:i5 -depends_on-> slot:i6',
      'orchestrator -delegates-> slot:i5',
      'orchestrator -delegates-> slot:i7',
    ]);
  });

  it('keeps every node reachable through a dependency cycle', () => {
    const body = plan([
      ['i3-a', 'x', 'i3-b', 'no', 'opus'],
      ['i3-b', 'y', 'i3-a', 'no', 'opus'],
    ]);
    const g = graph(
      [slot('i3-a'), slot('i3-b')],
      [{ number: 3, title: 't', body }],
    );
    expect(edgeList(g)).toEqual([
      'slot:i3-b -depends_on-> slot:i3-a',
      'slot:i3-a -depends_on-> slot:i3-b',
      'orchestrator -delegates-> slot:i3-a',
    ]);
  });

  it('shows each slot once — its first (latest) run', () => {
    const g = graph([
      slot('i1', { id: 'new' }),
      slot('i1', { id: 'old', status: 'ended' }),
    ]);
    expect(g.nodes).toHaveLength(2);
    expect((g.nodes[1] as FleetSlotNode).slotId).toBe('new');
  });
});
