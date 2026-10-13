import type { PlanSummary } from '@agentdock/shared';
import { Card } from '@andrewbehma/glass-ui/card';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import Link from 'next/link';
import { Time } from '../../lib/format/time';
import {
  PLAN_STATUS_LABEL,
  PLAN_STATUS_PILL,
  taskCountsText,
} from '../../lib/planner/format';
import { planHref } from '../../lib/planner/href';
import { VisibilityChip } from './plan-header';

/**
 * The plans the person may read (spec 172 UI): title, author, visibility
 * (a lock for a private one), status, task counts and when it last moved.
 * A list of cards rather than a table, so nothing scrolls at 390 px.
 */
export function PlanList({ plans }: { plans: readonly PlanSummary[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {plans.map((plan) => (
        <li key={plan.id}>
          <Card
            variant="content"
            pad="sm"
            className="relative flex min-w-0 flex-col gap-1.5 transition-colors focus-within:bg-hover hover:bg-hover"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Link
                href={planHref(plan.projectId, plan.id)}
                className="min-w-0 flex-1 font-medium break-words text-ink after:absolute after:inset-0 after:content-['']"
              >
                {plan.title}
              </Link>
              <VisibilityChip plan={plan} />
              <StatusPill
                size="sm"
                status={PLAN_STATUS_PILL[plan.status]}
                label={PLAN_STATUS_LABEL[plan.status]}
              />
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-3">
              <span>{plan.author.name}</span>
              <span>
                {plan.mode === 'dialogue' ? 'Dialogue' : 'Batch'} · v
                {plan.version}
              </span>
              <span>{taskCountsText(plan.taskCounts) ?? 'No tasks yet'}</span>
              <span>
                updated <Time value={plan.updatedAt} />
              </span>
            </div>
          </Card>
        </li>
      ))}
    </ul>
  );
}
