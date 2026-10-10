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
import { Badge } from 'glass-ui/badge';
import { Button } from 'glass-ui/button';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { EmptyState } from 'glass-ui/empty-state';
import { Field, Select } from 'glass-ui/field';
import { Skeleton } from 'glass-ui/skeleton';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { toast } from 'glass-ui/toast';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BudgetFormDialog } from '../../../components/budgets/budget-form-dialog';
import { OverrideDialog } from '../../../components/budgets/override-dialog';
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
  const [budgets, setBudgets] = useState<BudgetView[]>();
  const [scope, setScope] = useState<BudgetScope | ''>('');
  const [state, setState] = useState<BudgetState | ''>('');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);

  const [editing, setEditing] = useState<BudgetView | 'new'>();
  const [overriding, setOverriding] = useState<BudgetView>();
  const [deleting, setDeleting] = useState<BudgetView>();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [recomputing, setRecomputing] = useState(false);

  const load = useCallback(async () => {
    try {
      setBudgets(
        await api<BudgetView[]>(`/admin/budgets${query(scope, state)}`),
      );
    } catch (err) {
      toast.error(describeBudgetsError(err));
    }
  }, [scope, state]);

  useEffect(() => {
    void load();
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
      await load();
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
      await load();
    } catch (err) {
      toast.error(describeBudgetsError(err));
    } finally {
      setRecomputing(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Budgets</h1>
          <p className="max-w-prose text-sm text-ink-2">
            Every project and user budget. A stop budget refuses new
            orchestrator starts and skill runs once used up; running workers are
            never stopped. Recompute after prices were recalculated.
          </p>
        </div>
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
          <Button variant="glass" disabled={recomputing} onClick={recompute}>
            {recomputing ? 'Recomputing…' : 'Recompute'}
          </Button>
          <Button onClick={() => setEditing('new')}>New budget</Button>
        </div>
      </div>

      {!budgets ? (
        <Skeleton className="h-48 w-full" />
      ) : budgets.length === 0 ? (
        <EmptyState
          title="No budgets"
          description={
            scope || state
              ? 'No budget matches these filters.'
              : 'Create a project or user budget to cap spend.'
          }
        />
      ) : (
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
            {budgets.map((budget) => {
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
                      label={current ? STATE_LABEL[current.state] : 'disabled'}
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
                    {current ? formatMoment(current.end, budget.timezone) : '—'}
                    <div className="text-xs text-ink-3">{budget.timezone}</div>
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
                        variant="glass"
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
              <Button disabled={busyId !== null} onClick={remove}>
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
