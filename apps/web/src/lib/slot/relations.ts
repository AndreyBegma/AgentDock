import type {
  FleetGraph,
  FleetGraphNode,
  FleetNodePill,
} from '@nautelle/shared';

/** A slot the panel links to: another node of the fleet graph. */
export interface SlotLink {
  slot: string;
  issue: number | null;
  issueTitle: string | null;
  pill: FleetNodePill;
  /** `planned`: on the issue's Parallel plan, with no run yet. */
  planned: boolean;
}

export interface SlotRelations {
  /** Whether the slot is on the graph at all. */
  onGraph: boolean;
  /** Its children in the tree: the siblings it leads, the slots it delegates to. */
  subAgents: SlotLink[];
  /** The slots it waits for (`depends_on` into it). */
  waitsFor: SlotLink[];
  /** The slots waiting for it (`depends_on` out of it). */
  blocks: SlotLink[];
}

/** The graph id of a slot's node (`slot:<name>`, docs/specs/160-agent-workspace.md). */
export const slotNodeId = (slot: string): string => `slot:${slot}`;

const linkOf = (node: FleetGraphNode): SlotLink | null =>
  node.slot === null
    ? null
    : {
        slot: node.slot,
        issue: node.issue,
        issueTitle: node.issueTitle,
        pill: node.pill,
        planned: node.kind === 'planned',
      };

const bySlot = (a: SlotLink, b: SlotLink) => a.slot.localeCompare(b.slot);

/**
 * Sub-agents and dependencies of one slot, from the fleet graph's edges. The
 * orchestrator is never a link: it is not a slot the panel can open. An edge
 * from a node to itself is ignored, and each slot appears once per list.
 */
export function relationsOf(graph: FleetGraph, slot: string): SlotRelations {
  const self = slotNodeId(slot);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const collect = (ids: string[]): SlotLink[] => {
    const seen = new Set<string>();
    const links: SlotLink[] = [];
    for (const id of ids) {
      if (id === self || seen.has(id)) continue;
      seen.add(id);
      const node = nodes.get(id);
      const link = node ? linkOf(node) : null;
      if (link) links.push(link);
    }
    return links.sort(bySlot);
  };

  const out = graph.edges.filter((edge) => edge.from === self);
  const into = graph.edges.filter((edge) => edge.to === self);
  return {
    onGraph: nodes.has(self),
    subAgents: collect(
      out
        .filter((edge) => edge.kind === 'lead' || edge.kind === 'delegates')
        .map((edge) => edge.to),
    ),
    waitsFor: collect(
      into
        .filter((edge) => edge.kind === 'depends_on')
        .map((edge) => edge.from),
    ),
    blocks: collect(
      out.filter((edge) => edge.kind === 'depends_on').map((edge) => edge.to),
    ),
  };
}

/** The slot's own node, for a slot that has no run yet (`planned`). */
export const nodeOf = (
  graph: FleetGraph | undefined,
  slot: string,
): FleetGraphNode | undefined =>
  graph?.nodes.find((node) => node.id === slotNodeId(slot));
