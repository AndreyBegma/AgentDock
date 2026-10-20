'use client';

import {
  FlowGraph,
  FlowLegend,
  FlowNodeCard,
} from '@andrewbehma/glass-ui/flow-graph';
import type { PlanDetail } from '@nautelle/shared';
import { useMemo } from 'react';
import { KIND_LABEL } from '../../lib/planner/format';
import { nodeLabel, planGraph } from '../../lib/planner/graph';
import { IssueLinks } from './issue-links';
import { KIND_ICON } from './task-card';

const NODE_SIZE = { width: 232, height: 112 };

/**
 * The plan graph (spec 172 UI, centre): tasks as nodes coloured by kind,
 * `dependsOn` as edges, laid out left to right. After sending, each node
 * says its live status and links its issue and pull request. Clicking a node
 * opens the task, as its card does.
 */
export function PlanGraph({
  plan,
  selectedKey,
  onSelect,
}: {
  plan: PlanDetail;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
}) {
  const { nodes, edges } = useMemo(() => planGraph(plan), [plan]);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <FlowGraph
        label={`Plan graph of ${plan.title}`}
        nodes={nodes}
        edges={edges}
        layout="layered"
        direction="LR"
        nodeSize={NODE_SIZE}
        height={420}
        selectedId={selectedKey}
        onSelectionChange={onSelect}
        nodeLabel={nodeLabel}
        labels={{ empty: 'No tasks yet.' }}
        renderNode={(node) => {
          const Icon = KIND_ICON[node.data.task.kind];
          const issue = node.data.task.issue;
          return (
            <FlowNodeCard
              title={`${node.id} · ${node.data.title}`}
              tone={node.tone}
              hue={node.hue}
              status={node.data.status}
              icon={<Icon aria-hidden="true" className="size-4" />}
              meta={
                issue ? (
                  <IssueLinks issue={issue} className="nodrag nopan" />
                ) : (
                  KIND_LABEL[node.data.task.kind]
                )
              }
            />
          );
        }}
      />
      <FlowLegend kinds={['depends']} labels={{ depends: 'must land first' }} />
    </div>
  );
}
