'use client';

import type { PlanSummary } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { type Column, DataTable } from '@andrewbehma/glass-ui/data-table';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Time } from '../../lib/format/time';
import {
  PLAN_MODE_LABEL,
  planAttentionReason,
  planPill,
  taskCountsText,
} from '../../lib/planner/format';
import { planHref } from '../../lib/planner/href';
import { ScrollX } from '../scroll-x/scroll-x';
import { VisibilityChip } from './plan-header';

/** What a row needs to offer **Retry** on a plan whose newest turn failed. */
export interface PlanRetry {
  /** Operators only: a viewer reads the reason and no more. */
  allowed: boolean;
  /** The plan being retried now, if any. */
  retrying: string | null;
  onRetry: (plan: PlanSummary) => void;
}

export function planColumns(retry?: PlanRetry): Column<PlanSummary>[] {
  return [
    {
      id: 'plan',
      header: 'Plan',
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
              {plan.author.name} · {PLAN_MODE_LABEL[plan.mode]} · v
              {plan.version}
            </span>
            {reason ? (
              <span
                className="line-clamp-1 text-xs break-all text-status-error-ink"
                title={reason}
              >
                {reason}
              </span>
            ) : null}
            {retry?.allowed && plan.attention?.kind === 'failed' ? (
              <Button
                size="sm"
                variant="glass"
                className="mt-1 self-start"
                disabled={retry.retrying !== null}
                onClick={(event) => {
                  event.stopPropagation();
                  retry.onRetry(plan);
                }}
              >
                {retry.retrying === plan.id ? 'Retrying…' : 'Retry'}
              </Button>
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
        <span className="text-ink-2">
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
}

/**
 * The plans the person may read (spec 172 UI), a `DataTable` (#213): title
 * with its visibility (a lock for a private one), author, mode and version
 * under it and, when the newest turn failed, the reason; status; task
 * counts; when it last moved. Four columns, so it fits at 1440 beside the
 * rail; below that the table scrolls in its own box.
 */
export function PlanList({
  plans,
  retry,
}: {
  plans: readonly PlanSummary[];
  retry?: PlanRetry;
}) {
  const router = useRouter();
  return (
    <ScrollX label="Plans">
      <DataTable
        rows={[...plans]}
        getRowId={(plan) => plan.id}
        columns={planColumns(retry)}
        stickyHeader={false}
        onRowActivate={(plan) => router.push(planHref(plan.projectId, plan.id))}
      />
    </ScrollX>
  );
}
