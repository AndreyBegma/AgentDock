'use client';

import { FlowGraph } from '@andrewbehma/glass-ui/flow-graph';
import {
  type FleetGraph,
  type FleetGraphNode,
  ORCHESTRATOR_NODE_ID,
  slotNodeId,
} from '@nautelle/shared';
import { useMemo } from 'react';
import type { useControl } from '../../../../../lib/control/use-control';
import {
  AGENT_NODE_SIZE,
  EDGE_LEGEND_LABELS,
  nodeKey,
  nodeTitle,
  toCanvas,
} from '../../../../../lib/fleet/graph';
import { ORCHESTRATOR_KEY } from '../../../../../lib/fleet/workspace-url';
import { AgentNode } from './agent-node';

const CANVAS_HEIGHT = 'min(72vh, 760px)';
/**
 * glass-ui's FlowGraph gives React Flow no `onNodeClick` and turns selection
 * and dragging off, so React Flow sets `pointer-events: none` on every node:
 * a card can be neither clicked nor typed into with a mouse. Until glass-ui
 * fixes it, the nodes take pointer events back here. (Tailwind reads `_` in
 * a variant as a space, so the class's own underscores are escaped.)
 */
export const NODE_POINTER_FIX = String.raw`[&_.react-flow\_\_node]:pointer-events-auto!`;

/** The id of the node a URL key names. */
const nodeIdOf = (key: string | null): string | null =>
  key === null
    ? null
    : key === ORCHESTRATOR_KEY
      ? ORCHESTRATOR_NODE_ID
      : slotNodeId(key);

/**
 * The agent tree (#160): the orchestrator on top, a card per slot below it,
 * the wave structure as edges. Desktop only; a phone gets `AgentList`.
 */
export function AgentCanvas({
  graph,
  focus,
  control,
  canOperate,
  orchestratorMessageReason,
  onOpen,
  onAttach,
}: {
  graph: FleetGraph;
  /** The URL's `focus`: a slot name or `orchestrator`. */
  focus: string | null;
  control: ReturnType<typeof useControl>;
  canOperate: boolean;
  orchestratorMessageReason: string | null;
  onOpen: (key: string) => void;
  /** Admins on a runner that can attach; absent hides the action. */
  onAttach?: (key: string) => void;
}) {
  const { nodes, edges } = useMemo(() => toCanvas(graph), [graph]);
  return (
    <FlowGraph<FleetGraphNode>
      label="Agent tree"
      className={NODE_POINTER_FIX}
      nodes={nodes}
      edges={edges}
      layout="tree"
      direction="TB"
      nodeSize={AGENT_NODE_SIZE}
      gap={{ node: 40, rank: 72 }}
      height={CANVAS_HEIGHT}
      selectedId={nodeIdOf(focus)}
      onNodeClick={(node) => onOpen(nodeKey(node.data))}
      nodeLabel={(node) => nodeTitle(node.data)}
      labels={{ kinds: EDGE_LEGEND_LABELS }}
      renderNode={(node, state) => (
        <AgentNode
          node={node.data}
          selected={state.selected}
          control={control}
          canOperate={canOperate}
          orchestratorMessageReason={orchestratorMessageReason}
          onOpen={() => onOpen(nodeKey(node.data))}
          {...(onAttach
            ? { onAttach: () => onAttach(nodeKey(node.data)) }
            : {})}
        />
      )}
    />
  );
}

/** A phone's canvas: the same cards, one under the other, in the graph's order. */
export function AgentList({
  graph,
  focus,
  control,
  canOperate,
  orchestratorMessageReason,
  onOpen,
  onAttach,
}: {
  graph: FleetGraph;
  focus: string | null;
  control: ReturnType<typeof useControl>;
  canOperate: boolean;
  orchestratorMessageReason: string | null;
  onOpen: (key: string) => void;
  onAttach?: (key: string) => void;
}) {
  return (
    <ul className="flex flex-col gap-3" aria-label="Agents">
      {graph.nodes.map((node) => {
        const key = nodeKey(node);
        return (
          <li key={node.id}>
            <AgentNode
              node={node}
              selected={focus === key}
              control={control}
              canOperate={canOperate}
              orchestratorMessageReason={orchestratorMessageReason}
              onOpen={() => onOpen(key)}
              {...(onAttach ? { onAttach: () => onAttach(key) } : {})}
            />
          </li>
        );
      })}
    </ul>
  );
}
