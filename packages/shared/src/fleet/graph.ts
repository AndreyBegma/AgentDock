import type { CheckpointKind, PrChecks, SlotRuntime } from '../protocol';
import {
  parseDependsOn,
  parseParallelPlan,
  parseWaveDependencies,
} from '../queue/rules';
import type { OrchestratorView, PrState, SlotStatus } from './contracts';

/**
 * The agent workspace's tree (docs/specs/160-agent-workspace.md): the
 * orchestrator, one node per slot, and the wave structure as edges.
 */

/**
 * How far a slot's run got, from its reply-file checkpoints and its pull
 * request — the furthest reached, never set back by a later `blocked`.
 */
export const FLEET_STAGES = [
  'picked_up',
  'plan_ready',
  'implementation_done',
  'pr_open',
  'checks_green',
  'merged',
] as const;
export type FleetStage = (typeof FLEET_STAGES)[number];

/** The progress percentage a stage stands for (#160). */
export const FLEET_STAGE_PROGRESS: Record<FleetStage, number> = {
  picked_up: 10,
  plan_ready: 25,
  implementation_done: 60,
  pr_open: 80,
  checks_green: 90,
  merged: 100,
};

/**
 * The `StatusPill` of a node:
 * - `running` — the session is alive and its pane busy;
 * - `waiting` — dispatched but not up yet, idle, on a launch dialog, or a
 *   planned slot not dispatched yet;
 * - `paused` — on the quota banner, or its session died with work left (`stale`);
 * - `blocked` — its last checkpoint is `blocked` / `misclassified`, or its checks are red;
 * - `done` — its pull request merged, or the run ended.
 */
export const FLEET_NODE_PILLS = [
  'running',
  'waiting',
  'paused',
  'blocked',
  'done',
] as const;
export type FleetNodePill = (typeof FLEET_NODE_PILLS)[number];

/** What `stageOf` and `pillOf` read of a slot. */
export interface SlotStageInput {
  status: SlotStatus;
  lastCheckpoint: CheckpointKind | null;
  /** Every checkpoint kind the run's reply file reached, in any order. */
  checkpoints: readonly CheckpointKind[];
  prNumber: number | null;
  prState: PrState | null;
  prChecks: PrChecks | null;
}

const CHECKPOINT_STAGE: Partial<Record<CheckpointKind, FleetStage>> = {
  picked_up: 'picked_up',
  plan_ready: 'plan_ready',
  implementation_done: 'implementation_done',
  pr_open: 'pr_open',
};

/** The furthest stage a run reached; null before its first checkpoint. */
export const stageOf = (slot: SlotStageInput): FleetStage | null => {
  if (slot.prState === 'merged') return 'merged';
  const hasPr = slot.prNumber !== null && slot.prState !== 'closed';
  if (hasPr && slot.prChecks === 'green') return 'checks_green';
  let best = hasPr ? FLEET_STAGES.indexOf('pr_open') : -1;
  for (const kind of [...slot.checkpoints, slot.lastCheckpoint]) {
    const stage = kind ? CHECKPOINT_STAGE[kind] : undefined;
    if (stage) best = Math.max(best, FLEET_STAGES.indexOf(stage));
  }
  return best >= 0 ? FLEET_STAGES[best] : null;
};

/** The progress of a stage; 0 before the first checkpoint. */
export const progressOf = (stage: FleetStage | null): number =>
  stage ? FLEET_STAGE_PROGRESS[stage] : 0;

export const pillOf = (slot: SlotStageInput): FleetNodePill => {
  if (slot.status === 'ended' || slot.prState === 'merged') return 'done';
  if (
    slot.lastCheckpoint === 'blocked' ||
    slot.lastCheckpoint === 'misclassified' ||
    slot.prChecks === 'red'
  ) {
    return 'blocked';
  }
  switch (slot.status) {
    case 'running':
      return 'running';
    case 'quota':
    case 'stale':
      return 'paused';
    default:
      return 'waiting';
  }
};

/**
 * - `orchestrator` — the project's orchestrator; always present, id `orchestrator`;
 * - `slot` — a run of a slot (its latest), id `slot:<name>`;
 * - `planned` — a slot of an in-flight issue's `## Parallel plan` with no run
 *   yet (a sibling held for its lead), id `slot:<name>`.
 */
export type FleetNodeKind = 'orchestrator' | 'slot' | 'planned';

export const ORCHESTRATOR_NODE_ID = 'orchestrator';
export const slotNodeId = (slot: string): string => `slot:${slot}`;

interface FleetNodeBase {
  id: string;
  /** Null for the orchestrator. */
  slot: string | null;
  issue: number | null;
  /** The issue's title as the queue last saw it; null when not cached. */
  issueTitle: string | null;
  model: string | null;
  pill: FleetNodePill;
  stage: FleetStage | null;
  /** 0–100, from `stage` (`FLEET_STAGE_PROGRESS`). */
  progress: number;
}

export interface FleetOrchestratorNode extends FleetNodeBase {
  kind: 'orchestrator';
  slot: null;
  orchestrator: OrchestratorView;
}

export interface FleetSlotNode extends FleetNodeBase {
  kind: 'slot';
  slot: string;
  /** The slot row's id: `GET /projects/:id/slots/:slot` and the live push name it. */
  slotId: string;
  status: SlotStatus;
  runtime: SlotRuntime;
  modelWhy: string | null;
  lead: boolean | null;
  /** The worktree's branch (`worktree: <branch>` on the card). */
  branch: string | null;
  round: string | null;
  lastCheckpoint: CheckpointKind | null;
  prNumber: number | null;
  prUrl: string | null;
  prState: PrState | null;
  prChecks: PrChecks | null;
  startedAt: string;
  updatedAt: string;
}

export interface FleetPlannedNode extends FleetNodeBase {
  kind: 'planned';
  slot: string;
  lead: boolean;
}

export type FleetGraphNode =
  | FleetOrchestratorNode
  | FleetSlotNode
  | FleetPlannedNode;

/**
 * Edges point from the node that comes first to the one that follows:
 * - `delegates` — orchestrator → a slot nothing else in the graph leads to;
 * - `lead` — a wave's lead → a sibling with no `Depends on` of its own;
 * - `depends_on` — dependency → dependant: the plan's `Depends on` column
 *   within a wave, or `Depends on #m` between two issues on the graph (from
 *   each root slot of `#m` to each root slot of the dependant issue).
 *
 * "Returns result" sinks (build, tests) are drawn by the client from a node's
 * `prChecks`; they are not edges here.
 */
export const FLEET_EDGE_KINDS = ['delegates', 'lead', 'depends_on'] as const;
export type FleetEdgeKind = (typeof FLEET_EDGE_KINDS)[number];

export interface FleetGraphEdge {
  from: string;
  to: string;
  kind: FleetEdgeKind;
}

/** `GET /projects/:id/fleet/graph`. */
export interface FleetGraph {
  projectId: string;
  /** Orchestrator first, then slots by issue and plan order, then the rest by start. */
  nodes: FleetGraphNode[];
  /** Each `(from, to)` once; no self-loops. */
  edges: FleetGraphEdge[];
  generatedAt: string;
}

/** A slot as `buildFleetGraph` reads it: the summary plus what the stage needs. */
export interface FleetGraphSlotInput extends SlotStageInput {
  id: string;
  name: string;
  issue: number | null;
  runtime: SlotRuntime;
  model: string | null;
  modelWhy: string | null;
  lead: boolean | null;
  branch: string | null;
  round: string | null;
  prUrl: string | null;
  startedAt: string;
  updatedAt: string;
}

export interface FleetGraphIssueInput {
  number: number;
  title: string;
  /** The issue body: its `## Parallel plan` and `Depends on #m` lines. */
  body: string;
}

export interface FleetGraphInput {
  projectId: string;
  orchestrator: OrchestratorView;
  /** The latest run of each slot to show, newest first. */
  slots: readonly FleetGraphSlotInput[];
  /** The issues of those slots; others are ignored. */
  issues: readonly FleetGraphIssueInput[];
  generatedAt: string;
}

const ORCHESTRATOR_PILL: Record<OrchestratorView['status'], FleetNodePill> = {
  running: 'running',
  idle: 'waiting',
  absent: 'paused',
  unknown: 'paused',
};

/**
 * Builds the tree from slot runs and their issues. Pure: the API feeds it the
 * rows, the web can test against it.
 */
export const buildFleetGraph = (input: FleetGraphInput): FleetGraph => {
  const issues = new Map(input.issues.map((i) => [i.number, i]));
  const nodes: FleetGraphNode[] = [
    {
      id: ORCHESTRATOR_NODE_ID,
      kind: 'orchestrator',
      slot: null,
      issue: null,
      issueTitle: null,
      model: null,
      pill: ORCHESTRATOR_PILL[input.orchestrator.status],
      stage: null,
      progress: 0,
      orchestrator: input.orchestrator,
    },
  ];
  const bySlot = new Map<string, FleetSlotNode | FleetPlannedNode>();
  for (const slot of input.slots) {
    if (bySlot.has(slot.name)) continue;
    const stage = stageOf(slot);
    const node: FleetSlotNode = {
      id: slotNodeId(slot.name),
      kind: 'slot',
      slot: slot.name,
      slotId: slot.id,
      issue: slot.issue,
      issueTitle:
        slot.issue === null ? null : (issues.get(slot.issue)?.title ?? null),
      model: slot.model,
      modelWhy: slot.modelWhy,
      runtime: slot.runtime,
      lead: slot.lead,
      branch: slot.branch,
      round: slot.round,
      status: slot.status,
      lastCheckpoint: slot.lastCheckpoint,
      prNumber: slot.prNumber,
      prUrl: slot.prUrl,
      prState: slot.prState,
      prChecks: slot.prChecks,
      startedAt: slot.startedAt,
      updatedAt: slot.updatedAt,
      pill: pillOf(slot),
      stage,
      progress: progressOf(stage),
    };
    bySlot.set(slot.name, node);
  }

  const edges: FleetGraphEdge[] = [];
  const seen = new Set<string>();
  const edge = (from: string, to: string, kind: FleetEdgeKind) => {
    if (from === to) return;
    const key = `${from}\0${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, kind });
  };

  // Waves: each issue on the graph, its plan's slots in table order.
  const slotIssues = [
    ...new Set(
      [...bySlot.values()]
        .map((n) => n.issue)
        .filter((n): n is number => n !== null),
    ),
  ];
  const waveOf = new Map<number, string[]>();
  for (const number of slotIssues) {
    const body = issues.get(number)?.body ?? '';
    const plan = parseParallelPlan(body) ?? [];
    const dependencies = parseWaveDependencies(body) ?? new Map();
    for (const row of plan) {
      if (bySlot.has(row.slot)) continue;
      bySlot.set(row.slot, {
        id: slotNodeId(row.slot),
        kind: 'planned',
        slot: row.slot,
        issue: number,
        issueTitle: issues.get(number)?.title ?? null,
        model: row.model,
        lead: row.lead,
        pill: 'waiting',
        stage: null,
        progress: 0,
      });
    }
    const members = [
      ...plan.map((r) => r.slot),
      ...[...bySlot.values()]
        .filter((n) => n.issue === number)
        .map((n) => n.slot),
    ].filter((slot, i, all) => all.indexOf(slot) === i);
    waveOf.set(number, members);
    const lead =
      plan.find((r) => r.lead)?.slot ??
      members.find((slot) => bySlot.get(slot)?.lead === true);
    for (const slot of members) {
      const needs = dependencies.get(slot) ?? [];
      for (const dependency of needs) {
        edge(slotNodeId(dependency), slotNodeId(slot), 'depends_on');
      }
      if (lead && slot !== lead && needs.length === 0) {
        edge(slotNodeId(lead), slotNodeId(slot), 'lead');
      }
    }
  }

  // `Depends on #m` between two issues on the graph: root slots to root slots.
  const incomingWithin = (number: number, slot: string) =>
    edges.some(
      (e) =>
        e.to === slotNodeId(slot) &&
        (waveOf.get(number) ?? []).some((s) => slotNodeId(s) === e.from),
    );
  const rootsOf = (number: number) =>
    (waveOf.get(number) ?? []).filter((s) => !incomingWithin(number, s));
  const waveRoots = new Map(slotIssues.map((n) => [n, rootsOf(n)]));
  for (const number of slotIssues) {
    for (const blocker of parseDependsOn(issues.get(number)?.body ?? '')) {
      if (!waveRoots.has(blocker) || blocker === number) continue;
      for (const from of waveRoots.get(blocker) ?? []) {
        for (const to of waveRoots.get(number) ?? []) {
          edge(slotNodeId(from), slotNodeId(to), 'depends_on');
        }
      }
    }
  }

  // Order: waves by their first slot's position in the input, plan order within.
  const ordered: (FleetSlotNode | FleetPlannedNode)[] = [];
  const placed = new Set<string>();
  for (const slot of input.slots) {
    const node = bySlot.get(slot.name);
    if (!node || placed.has(node.slot)) continue;
    const wave = node.issue === null ? undefined : waveOf.get(node.issue);
    for (const member of wave ?? [node.slot]) {
      const memberNode = bySlot.get(member);
      if (memberNode && !placed.has(member)) {
        placed.add(member);
        ordered.push(memberNode);
      }
    }
  }

  const targets = new Set(edges.map((e) => e.to));
  for (const node of ordered) {
    if (!targets.has(node.id)) {
      edge(ORCHESTRATOR_NODE_ID, node.id, 'delegates');
    }
  }
  // A dependency cycle leaves its slots with no root: hang them off the orchestrator too.
  const reached = new Set([ORCHESTRATOR_NODE_ID]);
  const spread = () => {
    for (let grew = true; grew; ) {
      grew = false;
      for (const e of edges) {
        if (reached.has(e.from) && !reached.has(e.to)) {
          reached.add(e.to);
          grew = true;
        }
      }
    }
  };
  spread();
  for (const node of ordered) {
    if (reached.has(node.id)) continue;
    edge(ORCHESTRATOR_NODE_ID, node.id, 'delegates');
    reached.add(node.id);
    spread();
  }

  return {
    projectId: input.projectId,
    nodes: [...nodes, ...ordered],
    edges,
    generatedAt: input.generatedAt,
  };
};
