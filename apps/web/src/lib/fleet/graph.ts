import {
  type FleetEdgeKind,
  type FleetGraph,
  type FleetGraphNode,
  type FleetNodePill,
  type FleetStage,
  type OrchestratorStatus,
} from '@agentdock/shared';
import type { PrChecks } from '@agentdock/shared/protocol';
import type {
  FlowEdge,
  FlowEdgeKind,
  FlowNode,
  FlowNodeData,
} from '@andrewbehma/glass-ui/flow-graph';
import type { Hue } from '@andrewbehma/glass-ui/hue';
import type { MetaBarCounter } from '@andrewbehma/glass-ui/meta-bar';
import type { Status } from '@andrewbehma/glass-ui/status-pill';
import { slotHue } from '../hue';

/**
 * The agent workspace's canvas (#160), from `GET /projects/:id/fleet/graph`.
 * Pure: what the canvas, the dock and the "Dependencies & Flow" panel draw is
 * decided here and tested without a DOM.
 */

/** A node's pill is one of `StatusPill`'s states already. */
export const PILL_STATUS: Record<FleetNodePill, Status> = {
  running: 'running',
  waiting: 'waiting',
  paused: 'paused',
  blocked: 'blocked',
  done: 'done',
};

export const PILL_LABEL: Record<FleetNodePill, string> = {
  running: 'Running',
  waiting: 'Waiting',
  paused: 'Paused',
  blocked: 'Blocked',
  done: 'Done',
};

export const STAGE_LABEL: Record<FleetStage, string> = {
  picked_up: 'Picked up',
  plan_ready: 'Plan ready',
  implementation_done: 'Implementation done',
  pr_open: 'PR open',
  checks_green: 'Checks green',
  merged: 'Merged',
};

/**
 * The tree's edges in FlowGraph's vocabulary. A lead hands its siblings their
 * part, so `lead` draws as `delegates`; FlowGraph's tree layout places a node
 * under its first owner (`delegates`) before a `depends` edge, which is what
 * keeps a dependant beside its wave instead of hanging off its dependency.
 */
export const EDGE_KIND: Record<FleetEdgeKind, FlowEdgeKind> = {
  delegates: 'delegates',
  lead: 'delegates',
  depends_on: 'depends',
};

export const EDGE_LEGEND_LABELS = {
  depends: 'depends on',
  delegates: 'delegates to',
  returns: 'returns result',
} as const;

/** The card's box: a NodeCard with progress, a tag and a one-line prompt. */
export const AGENT_NODE_SIZE = { width: 288, height: 264 } as const;
/** The orchestrator's card has no progress or tag; a slot's box would leave its edges hanging. */
export const ORCHESTRATOR_NODE_SIZE = { width: 288, height: 152 } as const;

/** The node's key in the URL: its slot, or `orchestrator`. */
export const nodeKey = (node: FleetGraphNode): string =>
  node.slot ?? 'orchestrator';

export const nodeHue = (node: FleetGraphNode): Hue | undefined =>
  node.slot === null ? undefined : slotHue(node.slot);

export const nodeTitle = (node: FleetGraphNode): string =>
  node.slot ?? 'Orchestrator';

/** The issue line of a card: "#160 · Agent workspace", or what is known of it. */
export function issueLine(node: FleetGraphNode): string | null {
  if (node.issue === null) return node.issueTitle;
  return node.issueTitle
    ? `#${node.issue} · ${node.issueTitle}`
    : `#${node.issue}`;
}

/** "claude · opus"; a planned slot says it has not started. */
export function modelLine(node: FleetGraphNode): string {
  const model = node.model ?? 'model unknown';
  switch (node.kind) {
    case 'slot':
      return `${node.runtime} · ${model}`;
    case 'planned':
      return `planned · ${model}`;
    default:
      return node.orchestrator.session ?? 'no session';
  }
}

/** The progress bar's sentence, or null where a bar means nothing. */
export function progressBar(
  node: FleetGraphNode,
): { value: number; label: string } | null {
  if (node.kind === 'orchestrator') return null;
  return {
    value: node.progress,
    label: node.stage
      ? `${STAGE_LABEL[node.stage]} · ${node.progress}%`
      : 'Not started · 0%',
  };
}

export const ORCHESTRATOR_PILL_LABEL: Record<OrchestratorStatus, string> = {
  running: 'Live',
  idle: 'Active',
  absent: 'Not running',
  unknown: 'Unknown',
};

/** The header's pill: the orchestrator is the project's pulse. */
export const ORCHESTRATOR_HEADER_STATUS: Record<OrchestratorStatus, Status> = {
  running: 'running',
  idle: 'idle',
  absent: 'paused',
  unknown: 'idle',
};

export interface FleetCounts {
  agents: number;
  worktrees: number;
  running: number;
  blocked: number;
  done: number;
}

/** What the header counts: slots only, the orchestrator is not an agent here. */
export function fleetCounts(graph: FleetGraph): FleetCounts {
  const counts: FleetCounts = {
    agents: 0,
    worktrees: 0,
    running: 0,
    blocked: 0,
    done: 0,
  };
  for (const node of graph.nodes) {
    if (node.kind === 'orchestrator') continue;
    counts.agents += 1;
    if (node.kind === 'slot' && node.branch !== null) counts.worktrees += 1;
    if (node.pill === 'running') counts.running += 1;
    if (node.pill === 'blocked') counts.blocked += 1;
    if (node.pill === 'done') counts.done += 1;
  }
  return counts;
}

export function fleetCounters(counts: FleetCounts): MetaBarCounter[] {
  return [
    { id: 'agents', value: counts.agents, label: 'Agents' },
    { id: 'worktrees', value: counts.worktrees, label: 'Worktrees' },
    {
      id: 'running',
      value: counts.running,
      label: 'Running',
      ...(counts.running > 0 ? { tone: 'running' as const } : {}),
    },
    {
      id: 'blocked',
      value: counts.blocked,
      label: 'Blocked',
      ...(counts.blocked > 0 ? { tone: 'blocked' as const } : {}),
    },
    { id: 'done', value: counts.done, label: 'Completed' },
  ];
}

/**
 * The slots "Stop all" stops: every run with a session to kill. An ended run
 * has none, and a stale one lost it already.
 */
export const liveSlots = (graph: FleetGraph): string[] =>
  graph.nodes.flatMap((node) =>
    node.kind === 'slot' && node.status !== 'ended' && node.status !== 'stale'
      ? [node.slot]
      : [],
  );

export const runningSentence = (running: number): string =>
  `${running} ${running === 1 ? 'agent' : 'agents'} running`;

/** Slot nodes nobody has started yet are drawn too: they are the wave's plan. */
export function toCanvas(graph: FleetGraph): {
  nodes: FlowNode<FleetGraphNode>[];
  edges: FlowEdge[];
} {
  const pills = new Map(graph.nodes.map((n) => [n.id, n.pill]));
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      data: node,
      tone: PILL_STATUS[node.pill],
      ...(nodeHue(node) ? { hue: nodeHue(node) } : {}),
      size:
        node.kind === 'orchestrator' ? ORCHESTRATOR_NODE_SIZE : AGENT_NODE_SIZE,
    })),
    edges: graph.edges.map((edge) => ({
      source: edge.from,
      target: edge.to,
      kind: EDGE_KIND[edge.kind],
      // A pulse only into work that is moving now.
      animated: pills.get(edge.to) === 'running',
    })),
  };
}

export const SINK_BUILD = 'sink:build';
export const SINK_TESTS = 'sink:tests';

const CHECKS_STATUS: Record<PrChecks, Status> = {
  green: 'done',
  pending: 'waiting',
  red: 'blocked',
};

const CHECKS_WORD: Record<PrChecks, string> = {
  green: 'Passing',
  pending: 'Pending',
  red: 'Failing',
};

/** The worst of a set of checks: red over pending over green. */
export function worstChecks(checks: readonly PrChecks[]): PrChecks | null {
  if (checks.includes('red')) return 'red';
  if (checks.includes('pending')) return 'pending';
  return checks.length > 0 ? 'green' : null;
}

/**
 * "Dependencies & Flow": the same tree, left to right, plus two sinks the
 * results return to — a slot with a pull request feeds Build / run, and one
 * with checks feeds Test results, coloured by them.
 */
export function toDependencyFlow(graph: FleetGraph): {
  nodes: FlowNode<FlowNodeData>[];
  edges: FlowEdge[];
} {
  const nodes: FlowNode<FlowNodeData>[] = graph.nodes.map((node) => ({
    id: node.id,
    data: {
      title: nodeTitle(node),
      status: PILL_LABEL[node.pill],
      meta: node.issue === null ? undefined : `#${node.issue}`,
    },
    tone: PILL_STATUS[node.pill],
    ...(nodeHue(node) ? { hue: nodeHue(node) } : {}),
  }));
  const edges: FlowEdge[] = graph.edges.map((edge) => ({
    source: edge.from,
    target: edge.to,
    kind: EDGE_KIND[edge.kind],
  }));

  const built: string[] = [];
  const checks: PrChecks[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== 'slot' || node.prNumber === null) continue;
    built.push(node.id);
    if (node.prChecks !== null) {
      checks.push(node.prChecks);
      edges.push({
        source: node.id,
        target: SINK_TESTS,
        kind: 'returns',
        tone: CHECKS_STATUS[node.prChecks],
      });
    }
  }
  if (built.length > 0) {
    nodes.push({
      id: SINK_BUILD,
      data: {
        title: 'Build / run',
        meta: `${built.length} pull ${built.length === 1 ? 'request' : 'requests'}`,
      },
    });
    for (const id of built) {
      edges.push({ source: id, target: SINK_BUILD, kind: 'returns' });
    }
  }
  const worst = worstChecks(checks);
  if (worst !== null) {
    nodes.push({
      id: SINK_TESTS,
      data: { title: 'Test results', status: CHECKS_WORD[worst] },
      tone: CHECKS_STATUS[worst],
    });
  }
  return { nodes, edges };
}
