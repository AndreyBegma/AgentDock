'use client';

import type { BudgetView, ProjectSummary } from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import {
  budgetTone,
  formatLimit,
  formatPercent,
  PERIOD_LABEL,
} from '../../lib/budgets/format';
import { useMyBudgets } from '../../lib/budgets/use-budgets';

/** The enabled budget that is closest to (or past) its limit. */
export function tightestBudget(
  budgets: readonly BudgetView[],
): BudgetView | undefined {
  return budgets
    .filter((b) => b.enabled && b.current)
    .sort((a, b) => (b.current?.percent ?? 0) - (a.current?.percent ?? 0))[0];
}

/**
 * "Alpha · 32 % of $10.00 / day" as a link to where the budget is managed.
 * Draws nothing when the scope has no enabled budget.
 */
export function BudgetChip({
  name,
  budgets,
  href,
}: {
  name: string;
  budgets: readonly BudgetView[];
  href?: string;
}) {
  const budget = tightestBudget(budgets);
  if (!budget?.current) return null;
  const text = `${name} · ${formatPercent(budget.current.percent)} of ${formatLimit(budget.limitUsd)} ${PERIOD_LABEL[budget.period].toLowerCase()} · ${budget.current.state}`;
  const badge = <Badge tone={budgetTone(budget.current.state)} label={text} />;
  return href ? (
    <Link href={href} className="rounded-full focus-visible:outline-2">
      {badge}
    </Link>
  ) : (
    badge
  );
}

/**
 * The usage page's budget chips (spec 28 UI): one per project in view, and
 * "your budget" for the signed-in user. A project the caller cannot read, or
 * one that fails to answer, simply has no chip — the page works without them.
 */
export function BudgetStrip({
  projects,
  userId,
}: {
  projects: readonly Pick<ProjectSummary, 'id' | 'displayName'>[];
  userId: string;
}) {
  const mine = useMyBudgets(userId);
  const [byProject, setByProject] = useState<Record<string, BudgetView[]>>({});

  const key = projects.map((p) => p.id).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `projects`
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      projects.map((project) =>
        api<BudgetView[]>(`/projects/${project.id}/budgets`)
          .then((list) => [project.id, list] as const)
          .catch(() => [project.id, [] as BudgetView[]] as const),
      ),
    ).then((entries) => {
      if (!cancelled) setByProject(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  const showMine = mine.budgets !== undefined && !!tightestBudget(mine.budgets);
  const withBudget = projects.filter((p) =>
    tightestBudget(byProject[p.id] ?? []),
  );
  if (!showMine && withBudget.length === 0) return null;

  return (
    <ul aria-label="Budgets" className="mb-4 flex flex-wrap gap-2">
      {showMine ? (
        <li>
          <BudgetChip name="Your budget" budgets={mine.budgets ?? []} />
        </li>
      ) : null}
      {withBudget.map((project) => (
        <li key={project.id}>
          <BudgetChip
            name={project.displayName}
            budgets={byProject[project.id] ?? []}
            href={`/projects/${project.id}/settings?tab=budget`}
          />
        </li>
      ))}
    </ul>
  );
}
