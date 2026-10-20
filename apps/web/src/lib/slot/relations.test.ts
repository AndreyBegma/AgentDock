import { describe, expect, test } from 'bun:test';
import type {
  FleetGraph,
  FleetGraphEdge,
  FleetGraphNode,
  FleetNodePill,
} from '@nautelle/shared';
import { nodeOf, relationsOf, slotNodeId } from './relations';

const AT = '2026-10-14T10:00:00.000Z';

const orchestrator: FleetGraphNode = {
  id: 'orchestrator',
  kind: 'orchestrator',
  slot: null,
  issue: null,
  issueTitle: null,
  model: null,
  pill: 'running',
  stage: null,
  progress: 0,
  orchestrator: { status: 'running', session: 'fd', since: AT },
};

const slotNode = (
  name: string,
  pill: FleetNodePill = 'running',
): FleetGraphNode => ({
  id: slotNodeId(name),
  kind: 'slot',
  slot: name,
  slotId: `id-${name}`,
  issue: 160,
  issueTitle: 'Agent workspace',
  model: 'opus',
  pill,
  stage: 'plan_ready',
  progress: 25,
  status: 'running',
  runtime: 'claude',
  modelWhy: null,
  lead: null,
  branch: `feat/${name}`,
  round: null,
  lastCheckpoint: 'plan_ready',
  prNumber: null,
  prUrl: null,
  prState: null,
  prChecks: null,
  startedAt: AT,
  updatedAt: AT,
});

const plannedNode = (name: string): FleetGraphNode => ({
  id: slotNodeId(name),
  kind: 'planned',
  slot: name,
  issue: 160,
  issueTitle: 'Agent workspace',
  model: 'opus',
  pill: 'waiting',
  stage: null,
  progress: 0,
  lead: false,
});

const edge = (
  from: string,
  to: string,
  kind: FleetGraphEdge['kind'],
): FleetGraphEdge => ({
  from: from === 'orchestrator' ? from : slotNodeId(from),
  to: slotNodeId(to),
  kind,
});

const graphOf = (
  nodes: FleetGraphNode[],
  edges: FleetGraphEdge[],
): FleetGraph => ({ projectId: 'p1', nodes, edges, generatedAt: AT });

// A wave: data leads canvas and panel; panel also waits for canvas; another
// issue's slot depends on panel.
const wave = graphOf(
  [
    orchestrator,
    slotNode('i160-data', 'done'),
    slotNode('i160-canvas'),
    plannedNode('i160-panel'),
    slotNode('i161-api', 'waiting'),
  ],
  [
    edge('orchestrator', 'i160-data', 'delegates'),
    edge('i160-data', 'i160-canvas', 'lead'),
    edge('i160-data', 'i160-panel', 'depends_on'),
    edge('i160-canvas', 'i160-panel', 'depends_on'),
    edge('i160-panel', 'i161-api', 'depends_on'),
  ],
);

describe('relationsOf', () => {
  test('a lead has its siblings as sub-agents', () => {
    const r = relationsOf(wave, 'i160-data');
    expect(r.subAgents.map((l) => l.slot)).toEqual(['i160-canvas']);
    expect(r.blocks.map((l) => l.slot)).toEqual(['i160-panel']);
    expect(r.waitsFor).toEqual([]);
  });

  test('depends_on in is "waits for", out is "blocks", sorted by name', () => {
    const r = relationsOf(wave, 'i160-panel');
    expect(r.waitsFor.map((l) => l.slot)).toEqual(['i160-canvas', 'i160-data']);
    expect(r.blocks.map((l) => l.slot)).toEqual(['i161-api']);
    expect(r.subAgents).toEqual([]);
    expect(r.onGraph).toBe(true);
  });

  test('a link carries the node pill, and whether it is only planned', () => {
    const [data] = relationsOf(wave, 'i160-canvas').waitsFor;
    expect(data).toBeUndefined();
    const [panel] = relationsOf(wave, 'i161-api').waitsFor;
    expect(panel).toEqual({
      slot: 'i160-panel',
      issue: 160,
      issueTitle: 'Agent workspace',
      pill: 'waiting',
      planned: true,
    });
    const [canvas] = relationsOf(wave, 'i160-data').subAgents;
    expect(canvas.pill).toBe('running');
    expect(canvas.planned).toBe(false);
  });

  test('the orchestrator is never a link', () => {
    const r = relationsOf(wave, 'i160-data');
    expect(r.waitsFor).toEqual([]);
    expect(r.subAgents.some((l) => l.slot === 'orchestrator')).toBe(false);
  });

  test('a self edge and a repeated edge count once at most', () => {
    const g = graphOf(
      [orchestrator, slotNode('a'), slotNode('b')],
      [
        edge('a', 'a', 'depends_on'),
        edge('a', 'b', 'lead'),
        edge('a', 'b', 'lead'),
      ],
    );
    const r = relationsOf(g, 'a');
    expect(r.blocks).toEqual([]);
    expect(r.subAgents.map((l) => l.slot)).toEqual(['b']);
  });

  test('an edge to a node that is not on the graph is skipped', () => {
    const g = graphOf(
      [orchestrator, slotNode('a')],
      [edge('a', 'gone', 'lead')],
    );
    expect(relationsOf(g, 'a').subAgents).toEqual([]);
  });

  test('a slot that is not on the graph has no relations', () => {
    expect(relationsOf(wave, 'i999-x')).toEqual({
      onGraph: false,
      subAgents: [],
      waitsFor: [],
      blocks: [],
    });
  });
});

describe('nodeOf', () => {
  test('finds the slot node by name, and nothing without a graph', () => {
    expect(nodeOf(wave, 'i160-panel')?.kind).toBe('planned');
    expect(nodeOf(wave, 'nope')).toBeUndefined();
    expect(nodeOf(undefined, 'i160-panel')).toBeUndefined();
  });
});
