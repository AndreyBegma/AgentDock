'use client';

import type { PlanSummary } from '@agentdock/shared';
import { type Column, DataTable } from '@andrewbehma/glass-ui/data-table';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Time } from '../../lib/format/time';
import {
  planAttentionReason,
  planPill,
  taskCountsText,
} from '../../lib/planner/format';
import { planHref } from '../../lib/planner/href';
import { ScrollX } from '../scroll-x/scroll-x';
import { VisibilityChip } from './plan-header';

const columns: Column<PlanSummary>[] = [
  {
    id: 'plan',
    header: 'Plan',
    width: '40%',
    cell: (plan) => {
      const reason = planAttentionReason(plan);
      return (
        <span className="flex min-w-64 flex-col gap-0.5 py-1">
          <span className="flex min-w-0 items-center gap-2">
            <Link
              href={planHref(plan.projectId, plan.id)}
              className="min-w-0 truncate font-medium text-ink underline-offset-2 hover:underline"
              title={plan.title}
            >
              {plan.title}
            </Link>
            <VisibilityChip plan={plan} />
          </span>
          <span className="text-xs text-ink-3">
            {plan.author.name} ·{' '}
            {plan.mode === 'dialogue' ? 'Dialogue' : 'Batch'} · v{plan.version}
          </span>
          {reason ? (
            <span
              className="line-clamp-1 text-xs break-all text-status-error-ink"
              title={reason}
            >
              {reason}
            </span>
          ) : null}
        </span>
      );
    },
  },
  {
    id: 'status',
    header: 'Status',
    cell: (plan) => {
      const pill = planPill(plan);
      return <StatusPill size="sm" status={pill.status} label={pill.label} />;
    },
  },
  {
    id: 'tasks',
    header: 'Tasks',
    cell: (plan) => (
      <span className="whitespace-nowrap text-ink-2">
        {taskCountsText(plan.taskCounts) ?? 'No tasks yet'}
      </span>
    ),
  },
  {
    id: 'updated',
    header: 'Updated',
    cell: (plan) => (
      <span className="whitespace-nowrap text-ink-2">
        <Time value={plan.updatedAt} />
      </span>
    ),
  },
];

/**
 * The plans the person may read (spec 172 UI), a `DataTable` (#213): title
 * with its visibility (a lock for a private one), author, mode and version
 * under it and, when the newest turn failed, the reason; status; task
 * counts; when it last moved. Four columns, so it fits at 1440 beside the
 * rail; below that the table scrolls in its own box.
 */
export function PlanList({ plans }: { plans: readonly PlanSummary[] }) {
  const router = useRouter();
  return (
    <ScrollX label="Plans">
      <DataTable
        rows={[...plans]}
        getRowId={(plan) => plan.id}
        columns={columns}
        stickyHeader={false}
        onRowActivate={(plan) => router.push(planHref(plan.projectId, plan.id))}
      />
    </ScrollX>
  );
}
