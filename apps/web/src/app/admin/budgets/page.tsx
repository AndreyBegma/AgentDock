'use client';

import {
  type AdminUser,
  BUDGET_SCOPES,
  BUDGET_STATES,
  type BudgetRecomputeResult,
  type BudgetScope,
  type BudgetState,
  type BudgetView,
  type ProjectSummary,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Field, Select } from '@andrewbehma/glass-ui/field';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import { toast } from '@andrewbehma/glass-ui/toast';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { BudgetFormDialog } from '../../../components/budgets/budget-form-dialog';
import { OverrideDialog } from '../../../components/budgets/override-dialog';
import { PageHeader } from '../../../components/page-header/page-header';
import { AsyncSection } from '../../../components/prerequisites/async-section';
import { api } from '../../../lib/api';
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
import { useSection } from '../../../lib/section/use-section';

/** The page polls; the budget tab is the one that listens to live events. */
const POLL_MS = 15_000;

const query = (scope: BudgetScope | '', state: BudgetState | ''): string => {
  const params = new URLSearchParams();
  if (scope) params.set('scope', scope);
  if (state) params.set('state', state);
  const text = params.toString();
  return text ? `?${text}` : '';
};

export default function AdminBudgetsPage() {
  const [scope, setScope] = useState<BudgetScope | ''>('');
  const [state, setState] = useState<BudgetState | ''>('');
  const budgets = useSection(
    () => api<BudgetView[]>(`/admin/budgets${query(scope, state)}`),
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
      toast.error(describeBudgetsError(err));
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
      toast.error(describeBudgetsError(err));
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
          noBudgets ? null : (
            <>
              <Button
                variant="glass"
                disabled={recomputing}
                onClick={recompute}
              >
                {recomputing ? 'Recomputing…' : 'Recompute totals'}
              </Button>
              <Button onClick={() => setEditing('new')}>New budget</Button>
            </>
          )
        }
      />
      {noBudgets ? null : (
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Scope" htmlFor="budgets-scope">
            <Select
              id="budgets-scope"
              value={scope}
              onChange={(e) =>
                setScope(BUDGET_SCOPES.find((s) => s === e.target.value) ?? '')
              }
            >
              <option value="">All</option>
              {BUDGET_SCOPES.map((s) => (
                <option key={s} value={s}>
                  {SCOPE_LABEL[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="State" htmlFor="budgets-state">
            <Select
              id="budgets-state"
              value={state}
              onChange={(e) =>
                setState(BUDGET_STATES.find((s) => s === e.target.value) ?? '')
              }
            >
              <option value="">Any</option>
              {BUDGET_STATES.map((s) => (
                <option key={s} value={s}>
                  {STATE_LABEL[s]}
                </option>
              ))}
            </Select>
          </Field>
          <p className="max-w-prose pb-2 text-xs text-ink-3">
            Recompute totals adds up spend again from stored costs — run it
            after{' '}
            <Link
              href="/admin/prices"
              className="text-ink underline underline-offset-2"
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
                  onClick={() => {
                    setScope('');
                    setState('');
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No budgets yet"
              description="Cap what a project or a person may spend per day, week or month."
              action={
                <Button onClick={() => setEditing('new')}>New budget</Button>
              }
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

      <DialogRoot
        open={deleting !== undefined}
        onOpenChange={(open) => !open && setDeleting(undefined)}
      >
        <DialogContent
          title="Delete budget"
          description={
            deleting
              ? `The ${PERIOD_LABEL[deleting.period].toLowerCase()} budget of ${scopeName(deleting)} and its history are removed, and starts it refused are allowed again. This is audited.`
              : undefined
          }
          footer={
            <>
              <Button variant="glass" onClick={() => setDeleting(undefined)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={busyId !== null}
                onClick={remove}
              >
                Delete
              </Button>
            </>
          }
        >
          <p className="text-sm text-ink-2">This cannot be undone.</p>
        </DialogContent>
      </DialogRoot>
    </div>
  );
}
