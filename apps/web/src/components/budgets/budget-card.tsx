import type { BudgetView } from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Banner } from 'glass-ui/banner';
import { Progress } from 'glass-ui/progress';
import type { ReactNode } from 'react';
import {
  ACTION_LABEL,
  budgetTone,
  formatMoment,
  PERIOD_LABEL,
  SCOPE_LABEL,
  STATE_LABEL,
  scopeName,
  spendLabel,
  unpricedHint,
} from '../../lib/budgets/format';

/** The 50 / 80 / 100 marks of a budget; the ones already notified are filled. */
export function ThresholdList({ budget }: { budget: BudgetView }) {
  const fired = budget.current?.firedThresholds ?? [];
  return (
    <ul
      aria-label="Thresholds"
      className="flex flex-wrap items-center gap-1.5 text-xs text-ink-2"
    >
      {budget.thresholds.map((threshold) => (
        <li key={threshold}>
          <Badge
            tone={fired.includes(threshold) ? 'warn' : 'neutral'}
            label={`${threshold} %${fired.includes(threshold) ? ' · notified' : ''}`}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * One budget: spend against the limit, its thresholds, the reset time and an
 * active override. `actions` is where the page puts its admin controls; a
 * read-only view passes none (spec 28 D10).
 */
export function BudgetCard({
  budget,
  actions,
  showScope = false,
}: {
  budget: BudgetView;
  actions?: ReactNode;
  /** Name the project or user the budget covers (the admin list). */
  showScope?: boolean;
}) {
  const current = budget.current;
  const state = current?.state;
  const unpriced = current ? unpricedHint(current.unpricedRequests) : undefined;
  const title = `${PERIOD_LABEL[budget.period]} budget`;

  return (
    <section
      aria-label={showScope ? `${title}, ${scopeName(budget)}` : title}
      className="flex flex-col gap-3 rounded-surface border border-line bg-raised p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">
            {title}
            {showScope
              ? ` · ${SCOPE_LABEL[budget.scope]} ${scopeName(budget)}`
              : ''}
          </h3>
          <Badge
            tone={budgetTone(state)}
            label={state ? STATE_LABEL[state] : 'disabled'}
          />
          <Badge tone="neutral" label={ACTION_LABEL[budget.action]} />
        </div>
        {actions ? <div className="flex gap-2">{actions}</div> : null}
      </div>

      <Progress
        value={current?.percent ?? 0}
        tone={budgetTone(state)}
        label={spendLabel(budget)}
        hint={unpriced}
      />

      <ThresholdList budget={budget} />

      {current ? (
        <p className="text-xs text-ink-3">
          Resets {formatMoment(current.end, budget.timezone)} ({budget.timezone}
          )
        </p>
      ) : (
        <p className="text-xs text-ink-3">
          Disabled: nothing is counted and nothing is refused.
        </p>
      )}

      {budget.override ? (
        <Banner tone="warn" title="Stop lifted by an administrator">
          Starts are allowed until{' '}
          {formatMoment(budget.override.until, budget.timezone)} (
          {budget.timezone}). Reason: {budget.override.reason}
          {budget.override.by ? ` — ${budget.override.by.email}` : ''}
        </Banner>
      ) : state === 'exceeded' && budget.action === 'stop' && current ? (
        <Banner tone="danger" title="New starts are refused">
          Orchestrator starts and skill runs wait until{' '}
          {formatMoment(current.end, budget.timezone)}. Running workers
          continue.
        </Banner>
      ) : null}
    </section>
  );
}
