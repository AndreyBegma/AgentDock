'use client';

import type {
  WorkflowsToolsResponse,
  WorkflowToolTransition,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { DataTable } from '@andrewbehma/glass-ui/data-table';
import { Sankey } from '@andrewbehma/glass-ui/sankey';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { type ReactNode, useMemo } from 'react';
import { ScrollX } from '../../../components/scroll-x/scroll-x';
import { formatNumber } from '../../../lib/format';
import { formatRate, toolSankey } from '../../../lib/workflows/format';

/** Past this many tools a side folds into "+N more"; the table still lists every row. */
const TOOLS_PER_COLUMN = 12;

const COLUMNS = [
  {
    id: 'flow',
    header: 'Transition',
    cell: (t: WorkflowToolTransition) => (
      <span className="font-mono text-xs">
        {t.from} → {t.to}
      </span>
    ),
  },
  {
    id: 'count',
    header: 'Count',
    align: 'end' as const,
    cell: (t: WorkflowToolTransition) => (
      <span className="num">{formatNumber(t.count)}</span>
    ),
  },
  {
    id: 'errors',
    header: 'Errors',
    align: 'end' as const,
    cell: (t: WorkflowToolTransition) => (
      <span className="num">{formatNumber(t.errors)}</span>
    ),
  },
  {
    id: 'share',
    header: 'Error share',
    align: 'end' as const,
    cell: (t: WorkflowToolTransition) =>
      t.errors > 0 ? (
        <Badge
          tone={t.errorShare >= 0.2 ? 'danger' : 'warn'}
          label={formatRate(t.errorShare)}
        />
      ) : (
        <span className="num text-ink-3">0%</span>
      ),
  },
];

/**
 * 2. Which tool follows which within a turn: the top transitions as a
 * two-column Sankey, then the same rows with their error share.
 */
export function ToolFlowCard({
  data,
  busy,
  unavailable,
  hasError,
  empty,
}: {
  data: WorkflowsToolsResponse | undefined;
  busy: boolean;
  unavailable: ReactNode;
  /** The last load failed: no skeleton under the `SectionUnavailable`. */
  hasError: boolean;
  empty: ReactNode;
}) {
  const graph = useMemo(
    () => (data ? toolSankey(data.transitions) : null),
    [data],
  );
  return (
    <section aria-labelledby="workflows-tools">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 id="workflows-tools" className="text-sm font-medium">
          2. Tool execution flow
        </h2>
        {data && data.transitions.length > 0 ? (
          <p className="num text-xs text-ink-3">
            Top {formatNumber(data.transitions.length)} of{' '}
            {formatNumber(data.distinctTransitions)} distinct transitions,{' '}
            {formatNumber(data.totalTransitions)} in all
          </p>
        ) : null}
      </div>
      {unavailable}
      {graph && data ? (
        data.transitions.length === 0 ? (
          empty
        ) : (
          <div
            aria-busy={busy}
            className={`flex flex-col gap-3 transition-opacity ${busy ? 'opacity-60' : ''}`}
          >
            <Sankey
              label="Tool execution flow"
              columns={graph.columns}
              nodes={graph.nodes}
              links={graph.links}
              maxPerColumn={TOOLS_PER_COLUMN}
              valueFormat={(value) => formatNumber(value)}
            />
            <ScrollX label="Tool transitions">
              <DataTable
                rows={data.transitions}
                getRowId={(t) => `${t.from}\u0000${t.to}`}
                columns={COLUMNS}
                className="min-w-[28rem]"
              />
            </ScrollX>
          </div>
        )
      ) : hasError ? null : (
        <Skeleton className="h-[320px] w-full" />
      )}
    </section>
  );
}
