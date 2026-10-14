'use client';

import type { WorkflowsOrchestrationResponse } from '@agentdock/shared';
import { Sankey, type SankeyNodeInfo } from '@andrewbehma/glass-ui/sankey';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { type ReactNode, useMemo } from 'react';
import { formatNumber } from '../../../lib/format';
import {
  ORCHESTRATION_MAX_PER_COLUMN,
  orchestrationSankey,
} from '../../../lib/workflows/format';

/**
 * 1. Sessions → main agent → subagent type → compactions → outcome. Every
 * root session takes one path, so each column sums to the session count.
 * A node click filters the page on that node.
 */
export function OrchestrationCard({
  data,
  busy,
  unavailable,
  hasError,
  empty,
  onNodeFilter,
}: {
  data: WorkflowsOrchestrationResponse | undefined;
  busy: boolean;
  /** `SectionUnavailable` when the last load failed; data stays below it. */
  unavailable: ReactNode;
  /** The last load failed: no skeleton under the `SectionUnavailable`. */
  hasError: boolean;
  empty: ReactNode;
  onNodeFilter: (nodeId: string) => void;
}) {
  const graph = useMemo(
    () => (data ? orchestrationSankey(data) : null),
    [data],
  );
  return (
    <section className="mb-6" aria-labelledby="workflows-orchestration">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 id="workflows-orchestration" className="text-sm font-medium">
          1. Agent orchestration
        </h2>
        <p className="text-xs text-ink-3">
          Width is sessions. Click a node to filter the page on it; the Sessions
          node clears the graph filters.
        </p>
      </div>
      {unavailable}
      {graph && data ? (
        data.sessions === 0 ? (
          empty
        ) : (
          <div
            aria-busy={busy}
            className={
              busy ? 'opacity-60 transition-opacity' : 'transition-opacity'
            }
          >
            <Sankey
              label={`Agent orchestration, ${formatNumber(data.sessions)} sessions`}
              columns={graph.columns}
              nodes={graph.nodes}
              links={graph.links}
              maxPerColumn={ORCHESTRATION_MAX_PER_COLUMN}
              valueFormat={(value) => formatNumber(value)}
              onNodeClick={(node: SankeyNodeInfo) => onNodeFilter(node.id)}
            />
          </div>
        )
      ) : hasError ? null : (
        <Skeleton className="h-[360px] w-full" />
      )}
    </section>
  );
}
