import type { PlanDetail, PlanTaskView } from '@agentdock/shared';
import type { FlowEdge, FlowNode } from '@andrewbehma/glass-ui/flow-graph';
import { KIND_HUE, KIND_LABEL, taskStatusView } from './format';

/** What a plan graph node carries: the task, and what its card says. */
export interface PlanNodeData {
  title: string;
  /** The status word beside the dot. */
  status: string;
  task: PlanTaskView;
}

/**
 * The plan graph (spec 172 UI): tasks as nodes coloured by kind, `dependsOn`
 * as `depends` edges from the dependency to the dependant. A node's tone is
 * its status — before sending the review state, after it the live one — and
 * an edge into a node takes that node's tone.
 *
 * Edges are built from the tasks' own `dependsOn` rather than `graph.edges`
 * alone, so a graph and the cards beside it can never disagree; the server's
 * edges fill in a node it knows and the task list does not (none, normally).
 */
export function planGraph(plan: Pick<PlanDetail, 'tasks' | 'graph'>): {
  nodes: FlowNode<PlanNodeData>[];
  edges: FlowEdge[];
} {
  const byKey = new Map(plan.tasks.map((t) => [t.key, t]));
  const nodes = plan.tasks.map((task): FlowNode<PlanNodeData> => {
    const view = taskStatusView(task);
    return {
      id: task.key,
      data: { title: task.title, status: view.label, task },
      tone: view.status,
      hue: KIND_HUE[task.kind],
    };
  });

  const seen = new Set<string>();
  const edges: FlowEdge[] = [];
  const add = (from: string, to: string) => {
    const id = `${from}->${to}`;
    if (from === to || seen.has(id) || !byKey.has(from) || !byKey.has(to)) {
      return;
    }
    seen.add(id);
    edges.push({ id, source: from, target: to, kind: 'depends' });
  };
  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) add(dep, task.key);
  }
  for (const edge of plan.graph.edges) add(edge.from, edge.to);
  return { nodes, edges };
}

/** How a node is announced: "Feature t2: Add the queue, Approved". */
export const nodeLabel = (node: FlowNode<PlanNodeData>): string =>
  `${KIND_LABEL[node.data.task.kind]} ${node.id}: ${node.data.title}, ${node.data.status}`;
