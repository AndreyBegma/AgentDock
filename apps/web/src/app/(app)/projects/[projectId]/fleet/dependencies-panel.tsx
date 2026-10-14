'use client';

import type { FleetGraph } from '@agentdock/shared';
import { Card } from '@andrewbehma/glass-ui/card';
import { FlowGraph, FlowLegend } from '@andrewbehma/glass-ui/flow-graph';
import { useMemo } from 'react';
import {
  EDGE_LEGEND_LABELS,
  toDependencyFlow,
} from '../../../../../lib/fleet/graph';

/**
 * "Dependencies & Flow" (#160): the tree again, layered left to right, with
 * the results returning to Build / run and Test results from the PR checks.
 */
export function DependenciesPanel({
  graph,
  id,
}: {
  graph: FleetGraph;
  /** The section's id, so "View dependencies" can scroll to it. */
  id: string;
}) {
  const flow = useMemo(() => toDependencyFlow(graph), [graph]);
  return (
    <Card
      pad="md"
      className="flex scroll-mt-4 flex-col gap-3"
      id={id}
      aria-labelledby={`${id}-title`}
      role="region"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="text-sm font-semibold">
          Dependencies &amp; Flow
        </h2>
        <FlowLegend labels={EDGE_LEGEND_LABELS} />
      </div>
      <FlowGraph
        label="Dependencies and flow"
        nodes={flow.nodes}
        edges={flow.edges}
        layout="layered"
        direction="LR"
        nodeSize={{ width: 168, height: 56 }}
        gap={{ node: 16, rank: 48 }}
        height={260}
        background={false}
        labels={{ kinds: EDGE_LEGEND_LABELS }}
      />
    </Card>
  );
}
