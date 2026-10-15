'use client';

import {
  type AdminUser,
  BUDGET_SCOPES,
  BUDGET_STATES,
  type BudgetRecomputeResult,
  type BudgetView,
  type ProjectSummary,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Select } from '@andrewbehma/glass-ui/field';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import { toast } from '@andrewbehma/glass-ui/toast';
import { Toolbar } from '@andrewbehma/glass-ui/toolbar';
import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { BudgetFormDialog } from '../../../components/budgets/budget-form-dialog';
import { OverrideDialog } from '../../../components/budgets/override-dialog';
import { PageHeader } from '../../../components/page-header/page-header';
import { AsyncSection } from '../../../components/prerequisites/async-section';
import { api } from '../../../lib/api';
import {
  BUDGET_CHIP_DEFS,
  BUDGET_FILTER_CODEC,
  budgetFiltersSearch,
} from '../../../lib/budgets/filters';
import {
  ACTION_LABEL,
  budgetTone,
  describeBudgetsError,
  formatBudgetUsd,
  formatLimit,
  formatMoment,
  formatPercent,
  PERIOD_LABEL,
  SCOPE_LABEL,
  STATE_LABEL,
  scopeName,
  unpricedHint,
} from '../../../lib/budgets/format';
import {
  useFilterChips,
  useUrlFilters,
} from '../../../lib/filters/use-url-filters';
import { useErrorToast } from '../../../lib/section/use-error-toast';
import { useSection } from '../../../lib/section/use-section';

/** The page polls; the budget tab is the one that listens to live events. */
const POLL_MS = 15_000;

function AdminBudgets() {
  const url = useUrlFilters(BUDGET_FILTER_CODEC);
  const { scope, state } = url.filters;
  const chips = useFilterChips(url, BUDGET_CHIP_DEFS);
  const showError = useErrorToast();
  const budgets = useSection(
    () =>
      api<BudgetView[]>(
        `/admin/budgets${budgetFiltersSearch({ scope, state })}`,
      ),
    [scope, state],
  );
  const load = budgets.retry;
  const filtered = scope !== '' || state !== '';
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);

  const [editing, setEditing] = useState<BudgetView | 'new'>();
  const [overriding, setOverriding] = useState<BudgetView>();
  const [deleting, setDeleting] = useState<BudgetView>();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [recomputing, setRecomputing] = useState(false);

  useEffect(() => {
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // The create form's pickers; the page works without them (edit, override).
  useEffect(() => {
    api<ProjectSummary[]>('/projects')
      .then(setProjects)
      .catch(() => undefined);
    api<AdminUser[]>('/admin/users?status=active')
      .then(setUsers)
      .catch(() => undefined);
  }, []);

  const projectChoices = useMemo(
    () => projects.map((p) => ({ id: p.id, label: p.displayName })),
    [projects],
  );
  const userChoices = useMemo(
    () => users.map((u) => ({ id: u.id, label: u.name ?? u.email })),
    [users],
  );

  const run = async (
    id: string,
    action: () => Promise<unknown>,
    done: string,
  ) => {
    setBusyId(id);
    try {
      await action();
      toast.success(done);
      load();
    } catch (err) {
      showError(describeBudgetsError(err));
    } finally {
      setBusyId(null);
    }
  };

  const revoke = (budget: BudgetView) =>
    run(
      budget.id,
      () => api(`/admin/budgets/${budget.id}/override`, { method: 'DELETE' }),
      'Override revoked — starts are refused again',
    );

  const remove = async () => {
    if (!deleting) return;
    const target = deleting;
    await run(
      target.id,
      () => api(`/admin/budgets/${target.id}`, { method: 'DELETE' }),
      'Budget deleted',
    );
    setDeleting(undefined);
  };

  const recompute = async () => {
    setRecomputing(true);
    try {
      const result = await api<BudgetRecomputeResult>(
        '/admin/budgets/recompute',
        { method: 'POST', body: {} },
      );
      toast.success(
        `Recomputed ${result.periods} period${result.periods === 1 ? '' : 's'} of ${result.budgets} budget${result.budgets === 1 ? '' : 's'}`,
      );
      load();
    } catch (err) {
      showError(describeBudgetsError(err));
    } finally {
      setRecomputing(false);
    }
  };

  // Nothing to filter or recompute until a first budget exists.
  const noBudgets = budgets.data?.length === 0 && !filtered;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Budgets"
        description={
          noBudgets
            ? 'Spending caps for projects and people.'
            : 'A stop budget refuses new orchestrator starts and skill runs once used up; running workers are never stopped.'
        }
        actions={
          <>
            {noBudgets ? null : (
              <Button
                variant="glass"
                disabled={recomputing}
                onClick={recompute}
              >
                {recomputing ? 'Recomputing…' : 'Recompute totals'}
              </Button>
            )}
            <Button onClick={() => setEditing('new')}>New budget</Button>
          </>
        }
      />
      {noBudgets ? null : (
        <div className="flex flex-col gap-2">
          <Toolbar
            aria-label="Filter budgets"
            collapseBelow="sm"
            activeFilters={chips.activeFilters}
            onClearAll={chips.onClearAll}
            filters={
              <>
                <Select
                  aria-label="Scope"
                  value={scope}
                  className="w-full sm:w-44"
                  onChange={(e) =>
                    url.set({
                      scope:
                        BUDGET_SCOPES.find((s) => s === e.target.value) ?? '',
                    })
                  }
                >
                  <option value="">All scopes</option>
                  {BUDGET_SCOPES.map((s) => (
                    <option key={s} value={s}>
                      {SCOPE_LABEL[s]}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label="State"
                  value={state}
                  className="w-full sm:w-44"
                  onChange={(e) =>
                    url.set({
                      state:
                        BUDGET_STATES.find((s) => s === e.target.value) ?? '',
                    })
                  }
                >
                  <option value="">Any state</option>
                  {BUDGET_STATES.map((s) => (
                    <option key={s} value={s}>
                      {STATE_LABEL[s]}
                    </option>
                  ))}
                </Select>
              </>
            }
          />
          <p className="max-w-prose text-xs text-ink-3">
            Recompute totals adds up spend again from stored costs — run it
            after{' '}
            <Link
              href="/admin/prices"
              className="text-accent-ink underline underline-offset-2"
            >
              re-pricing requests
            </Link>
            .
          </p>
        </div>
      )}

      <AsyncSection
        section={budgets}
        unavailable={{
          title: 'Budgets are not answering',
          stillWorks: 'Budgets keep refusing or allowing starts on the server.',
        }}
        skeleton={<Skeleton className="h-48 w-full" />}
        empty={
          filtered ? (
            <EmptyState
              title="No budget matches these filters"
              description="Other budgets are hidden by the scope or state filter."
              action={
                <Button
                  variant="glass"
                  onClick={() => url.replace({ scope: '', state: '' })}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No budgets yet"
              description="Cap what a project or a person may spend per day, week or month. New budget is at the top of the page."
            />
          )
        }
      >
        {(list) => (
          <Table scroll>
            <TableHead>
              <TableRow>
                <TableCell head>Scope</TableCell>
                <TableCell head>Period</TableCell>
                <TableCell head>Spent / limit</TableCell>
                <TableCell head>State</TableCell>
                <TableCell head>Action</TableCell>
                <TableCell head>Resets</TableCell>
                <TableCell head>
                  <span className="sr-only">Actions</span>
                </TableCell>
              </TableRow>
            </TableHead>
            <tbody>
              {list.map((budget) => {
                const current = budget.current;
                const busy = busyId === budget.id;
                const canOverride =
                  budget.action === 'stop' &&
                  budget.override === null &&
                  current?.state === 'exceeded';
                return (
                  <TableRow key={budget.id}>
                    <TableCell>
                      <div className="font-medium">{scopeName(budget)}</div>
                      <div className="text-xs text-ink-3">
                        {SCOPE_LABEL[budget.scope]}
                        {budget.enabled ? '' : ' · disabled'}
                      </div>
                    </TableCell>
                    <TableCell>{PERIOD_LABEL[budget.period]}</TableCell>
                    <TableCell>
                      {current ? (
                        <>
                          {formatBudgetUsd(current.spentUsd)} /{' '}
                          {formatLimit(budget.limitUsd)} (
                          {formatPercent(current.percent)})
                          {unpricedHint(current.unpricedRequests) ? (
                            <div className="text-xs text-ink-3">
                              {unpricedHint(current.unpricedRequests)}
                            </div>
                          ) : null}
                        </>
                      ) : (
                        formatLimit(budget.limitUsd)
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        tone={budgetTone(current?.state)}
                        label={
                          current ? STATE_LABEL[current.state] : 'disabled'
                        }
                      />
                      {budget.override ? (
                        <div className="text-xs text-ink-3">
                          until{' '}
                          {formatMoment(budget.override.until, budget.timezone)}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>{ACTION_LABEL[budget.action]}</TableCell>
                    <TableCell>
                      {current
                        ? formatMoment(current.end, budget.timezone)
                        : '—'}
                      <div className="text-xs text-ink-3">
                        {budget.timezone}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap justify-end gap-2">
                        {canOverride ? (
                          <Button
                            variant="glass"
                            disabled={busy}
                            onClick={() => setOverriding(budget)}
                          >
                            Override
                          </Button>
                        ) : null}
                        {budget.override ? (
                          <Button
                            variant="glass"
                            disabled={busy}
                            onClick={() => revoke(budget)}
                          >
                            Revoke
                          </Button>
                        ) : null}
                        <Button
                          variant="glass"
                          disabled={busy}
                          onClick={() => setEditing(budget)}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="danger"
                          disabled={busy}
                          onClick={() => setDeleting(budget)}
                        >
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </tbody>
          </Table>
        )}
      </AsyncSection>

      <BudgetFormDialog
        open={editing !== undefined}
        budget={editing === 'new' ? undefined : editing}
        projects={projectChoices}
        users={userChoices}
        onClose={() => setEditing(undefined)}
        onSaved={() => {
          setEditing(undefined);
          toast.success('Budget saved');
          void load();
        }}
      />

      <OverrideDialog
        budget={overriding}
        onClose={() => setOverriding(undefined)}
        onSaved={() => {
          setOverriding(undefined);
          toast.success('Override set — starts are allowed until it ends');
          void load();
        }}
      />

      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        title="Delete this budget?"
        consequence={
          deleting
            ? `The ${PERIOD_LABEL[deleting.period].toLowerCase()} budget of ${scopeName(deleting)} and its history are removed, and starts it refused are allowed again. This is audited and cannot be undone.`
            : undefined
        }
        verb="Delete"
        busy={busyId !== null}
        onConfirm={remove}
      />
    </div>
  );
}

export default function AdminBudgetsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <AdminBudgets />
    </Suspense>
  );
}
