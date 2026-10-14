import { describe, expect, test } from 'bun:test';
import type {
  FleetGraph,
  FleetOrchestratorNode,
  FleetPlannedNode,
  FleetSlotNode,
} from '@agentdock/shared';
import { slotHue } from '../hue';
import { ORCHESTRATOR_STATUS_LABEL } from './format';
import {
  AGENT_NODE_SIZE,
  fleetCounters,
  fleetCounts,
  issueLine,
  liveSlots,
  modelLine,
  nodeKey,
  nodeStatus,
  ORCHESTRATOR_NODE_SIZE,
  progressBar,
  runningSentence,
  SINK_BUILD,
  SINK_TESTS,
  toCanvas,
  toDependencyFlow,
  worstChecks,
} from './graph';

const orchestrator: FleetOrchestratorNode = {
  id: 'orchestrator',
  kind: 'orchestrator',
  slot: null,
  issue: null,
  issueTitle: null,
  model: null,
  pill: 'running',
  stage: null,
  progress: 0,
  orchestrator: { status: 'running', session: 'agentdock-fd', since: null },
};

const slot = (
  name: string,
  over: Partial<FleetSlotNode> = {},
): FleetSlotNode => ({
  id: `slot:${name}`,
  kind: 'slot',
  slot: name,
  slotId: `id-${name}`,
  issue: 160,
  issueTitle: 'Agent workspace',
  model: 'opus',
  pill: 'running',
  stage: 'plan_ready',
  progress: 25,
  status: 'running',
  runtime: 'claude',
  modelWhy: null,
  lead: false,
  branch: `feat/${name}`,
  round: null,
  lastCheckpoint: 'plan_ready',
  prNumber: null,
  prUrl: null,
  prState: null,
  prChecks: null,
  startedAt: '2026-10-14T10:00:00Z',
  updatedAt: '2026-10-14T10:00:00Z',
  ...over,
});

const planned = (name: string): FleetPlannedNode => ({
  id: `slot:${name}`,
  kind: 'planned',
  slot: name,
  issue: 160,
  issueTitle: null,
  model: 'opus',
  pill: 'waiting',
  stage: null,
  progress: 0,
  lead: false,
});

const graph = (
  nodes: FleetGraph['nodes'],
  edges: FleetGraph['edges'] = [],
): FleetGraph => ({
  projectId: 'p1',
  nodes,
  edges,
  generatedAt: '2026-10-14T10:00:00Z',
});

describe('card lines', () => {
  test('the issue line says the number and the title, or what is known', () => {
    expect(issueLine(slot('a'))).toBe('#160 · Agent workspace');
    expect(issueLine(slot('a', { issueTitle: null }))).toBe('#160');
    expect(issueLine(orchestrator)).toBeNull();
  });

  test('the model line names the runtime, or that the slot is planned', () => {
    expect(modelLine(slot('a'))).toBe('claude · opus');
    expect(modelLine(slot('a', { model: null }))).toBe(
      'claude · model unknown',
    );
    expect(modelLine(planned('b'))).toBe('planned · opus');
    expect(modelLine(orchestrator)).toBe('agentdock-fd');
  });

  test('progress is the stage and its percentage; none for the orchestrator', () => {
    expect(progressBar(slot('a'))).toEqual({
      value: 25,
      label: 'Plan ready · 25%',
    });
    expect(progressBar(planned('b'))).toEqual({
      value: 0,
      label: 'Not started · 0%',
    });
    expect(progressBar(orchestrator)).toBeNull();
  });

  test('the orchestrator node speaks the header’s vocabulary, not "Paused" (#213)', () => {
    const stopped: FleetOrchestratorNode = {
      ...orchestrator,
      pill: 'paused',
      orchestrator: { ...orchestrator.orchestrator, status: 'absent' },
    };
    expect(nodeStatus(stopped).label).toBe(ORCHESTRATOR_STATUS_LABEL.absent);
    expect(nodeStatus(stopped).label).toBe('Not running');
    expect(nodeStatus(slot('a', { pill: 'paused' })).label).toBe('Paused');
    expect(nodeStatus(planned('b')).label).toBe('Planned');
  });

  test('a node is keyed in the URL by its slot', () => {
    expect(nodeKey(slot('i42'))).toBe('i42');
    expect(nodeKey(orchestrator)).toBe('orchestrator');
  });
});

describe('fleetCounts', () => {
  test('counts slots, not the orchestrator; worktrees are runs with a branch', () => {
    const counts = fleetCounts(
      graph([
        orchestrator,
        slot('a'),
        slot('b', { pill: 'blocked', branch: null }),
        slot('c', { pill: 'done' }),
        planned('d'),
      ]),
    );
    expect(counts).toEqual({
      active: 3,
      worktrees: 2,
      running: 1,
      blocked: 1,
      done: 1,
    });
  });

  test('active is the runs that have not ended, as the card’s Slots counts them (#213)', () => {
    // The audit: "0 Agents" beside "Slots 5 / 5". Both now count the same set.
    const counts = fleetCounts(
      graph([
        orchestrator,
        slot('a'),
        slot('b', { status: 'stale', pill: 'paused' }),
        slot('c', { status: 'ended', pill: 'done' }),
        planned('d'),
      ]),
    );
    expect(counts.active).toBe(2);
    expect(counts.worktrees).toBe(2);
    expect(counts.done).toBe(1);
  });

  test('a counter is toned only when it has something to say', () => {
    const quiet = fleetCounters({
      active: 1,
      worktrees: 1,
      running: 0,
      blocked: 0,
      done: 1,
    });
    expect(quiet.every((c) => c.tone === undefined)).toBe(true);
    const loud = fleetCounters({
      active: 2,
      worktrees: 2,
      running: 1,
      blocked: 1,
      done: 0,
    });
    expect(loud.find((c) => c.id === 'running')?.tone).toBe('running');
    expect(loud.find((c) => c.id === 'blocked')?.tone).toBe('blocked');
  });

  test('Stop all stops every run with a session, not planned, ended or stale ones', () => {
    expect(
      liveSlots(
        graph([
          orchestrator,
          slot('a'),
          slot('b', { status: 'idle' }),
          slot('c', { status: 'ended' }),
          slot('d', { status: 'stale' }),
          planned('e'),
        ]),
      ),
    ).toEqual(['a', 'b']);
  });

  test('running sentence agrees in number', () => {
    expect(runningSentence(1)).toBe('1 agent running');
    expect(runningSentence(3)).toBe('3 agents running');
  });
});

describe('toCanvas', () => {
  test('nodes carry their pill as a tone and their slot as a hue', () => {
    const { nodes } = toCanvas(graph([orchestrator, slot('a')]));
    expect(nodes[0]?.hue).toBeUndefined();
    expect(nodes[0]?.tone).toBe('running');
    expect(nodes[1]?.hue).toBe(slotHue('a'));
  });

  test('the orchestrator gets a shorter box than a slot, so its edges leave its card', () => {
    const { nodes } = toCanvas(graph([orchestrator, slot('a')]));
    expect(nodes[0]?.size).toEqual(ORCHESTRATOR_NODE_SIZE);
    expect(nodes[1]?.size).toEqual(AGENT_NODE_SIZE);
  });

  test('lead draws as delegates, depends_on as depends; pulses only into running work', () => {
    const { edges } = toCanvas(
      graph(
        [orchestrator, slot('a'), slot('b', { pill: 'waiting' })],
        [
          { from: 'orchestrator', to: 'slot:a', kind: 'delegates' },
          { from: 'slot:a', to: 'slot:b', kind: 'lead' },
          { from: 'slot:a', to: 'slot:b', kind: 'depends_on' },
        ],
      ),
    );
    expect(edges.map((e) => [e.kind, e.animated])).toEqual([
      ['delegates', true],
      ['delegates', false],
      ['depends', false],
    ]);
  });
});

describe('toDependencyFlow', () => {
  test('no pull request, no sinks', () => {
    const flow = toDependencyFlow(graph([orchestrator, slot('a')]));
    expect(flow.nodes.map((n) => n.id)).toEqual(['orchestrator', 'slot:a']);
  });

  test('a PR returns to Build / run; its checks to Test results, toned by the worst', () => {
    const flow = toDependencyFlow(
      graph([
        orchestrator,
        slot('a', { prNumber: 1, prChecks: 'green' }),
        slot('b', { prNumber: 2, prChecks: 'red' }),
        slot('c', { prNumber: 3 }),
      ]),
    );
    const tests = flow.nodes.find((n) => n.id === SINK_TESTS);
    expect(tests?.tone).toBe('blocked');
    expect(tests?.data.status).toBe('Failing');
    expect(flow.nodes.find((n) => n.id === SINK_BUILD)?.data.meta).toBe(
      '3 pull requests',
    );
    const returns = flow.edges.filter((e) => e.kind === 'returns');
    expect(returns.filter((e) => e.target === SINK_BUILD)).toHaveLength(3);
    expect(
      returns
        .filter((e) => e.target === SINK_TESTS)
        .map((e) => [e.source, e.tone]),
    ).toEqual([
      ['slot:a', 'done'],
      ['slot:b', 'blocked'],
    ]);
  });

  test('worstChecks: red over pending over green', () => {
    expect(worstChecks([])).toBeNull();
    expect(worstChecks(['green', 'pending'])).toBe('pending');
    expect(worstChecks(['green', 'red', 'pending'])).toBe('red');
    expect(worstChecks(['green'])).toBe('green');
  });
});
