'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import type { Column } from '@andrewbehma/glass-ui/data-table';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import type { PlanSummary } from '@nautelle/shared';
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
import { ResponsiveRows } from '../responsive-rows/responsive-rows';
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
      // The plan takes what is left; the other columns keep to their content.
      width: '100%',
      cell: (plan) => {
        const reason = planAttentionReason(plan);
        // The table cell is `nowrap`; the title and the reason wrap here so a
        // long one cannot push the other columns off the table (C-301).
        return (
          <span className="flex min-w-0 flex-col gap-0.5 py-1 whitespace-normal desktop:min-w-64">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <Link
                href={planHref(plan.projectId, plan.id)}
                className="line-clamp-2 min-w-0 font-medium text-ink wrap-anywhere underline-offset-2 hover:underline"
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
 * The plans the person may read (spec 172 UI): a table on a desktop, with
 * the title and its visibility (a lock for a private one), author, mode and
 * version under it and, when the newest turn failed, the reason; status; task
 * counts; when it last moved. On a tablet and a phone each plan is a stacked
 * row (stack S-7, C-301), so nothing scrolls sideways.
 */
export function PlanList({
  plans,
  retry,
}: {
  plans: readonly PlanSummary[];
  retry?: PlanRetry;
}) {
  const router = useRouter();
  const columns = planColumns(retry);
  return (
    <ResponsiveRows
      label="Plans"
      rows={[...plans]}
      getRowId={(plan) => plan.id}
      columns={columns}
      stackBelow="desktop"
      onRowActivate={(plan) => router.push(planHref(plan.projectId, plan.id))}
      stacked={(plan) => {
        const pill = planPill(plan);
        return (
          <div className="flex flex-col gap-2">
            {columns[0]?.cell(plan)}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2">
              <StatusPill size="sm" status={pill.status} label={pill.label} />
              <span>{taskCountsText(plan.taskCounts) ?? 'No tasks yet'}</span>
              <Time value={plan.updatedAt} />
            </div>
          </div>
        );
      }}
    />
  );
}
