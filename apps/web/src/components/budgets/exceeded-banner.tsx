'use client';

import { Banner } from 'glass-ui/banner';
import Link from 'next/link';
import { formatMoment, refusingBudget } from '../../lib/budgets/format';
import { useProjectBudgets } from '../../lib/budgets/use-budgets';

/**
 * Fleet page notice (spec 28 UI): while a `stop` budget of the project is
 * exceeded, new starts and skill runs are refused until it resets. Running
 * workers carry on (D7). Draws nothing otherwise, or when the budgets cannot
 * be read — the fleet page must not depend on them.
 */
export function BudgetExceededBanner({ projectId }: { projectId: string }) {
  const { budgets } = useProjectBudgets(projectId);
  const budget = budgets ? refusingBudget(budgets) : undefined;
  if (!budget?.current) return null;
  return (
    <Banner
      tone="danger"
      title="Budget used up — new spend is refused"
      action={
        <Link
          href={`/projects/${projectId}/settings?tab=budget`}
          className="text-sm underline underline-offset-2"
        >
          Open budget
        </Link>
      }
    >
      New orchestrator starts and skill runs are refused until{' '}
      {formatMoment(budget.current.end, budget.timezone)} ({budget.timezone}).
      Workers that are already running continue.
    </Banner>
  );
}
