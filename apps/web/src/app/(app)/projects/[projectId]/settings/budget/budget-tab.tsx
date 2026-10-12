'use client';

import type { BudgetView } from '@agentdock/shared';
import { Button } from 'glass-ui/button';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { EmptyState } from 'glass-ui/empty-state';
import { Skeleton } from 'glass-ui/skeleton';
import { toast } from 'glass-ui/toast';
import { useState } from 'react';
import { BudgetCard } from '../../../../../../components/budgets/budget-card';
import { BudgetFormDialog } from '../../../../../../components/budgets/budget-form-dialog';
import { api } from '../../../../../../lib/api';
import {
  describeBudgetsError,
  PERIOD_LABEL,
} from '../../../../../../lib/budgets/format';
import { useProjectBudgets } from '../../../../../../lib/budgets/use-budgets';

/**
 * The project's budgets (spec 28 UI). Every member reads; only a project admin
 * sees the create / edit / delete controls (D10) — the API refuses the rest.
 * An override is an admin act on `/admin/budgets`, so the tab only shows it.
 */
export function BudgetTab({
  projectId,
  isAdmin,
}: {
  projectId: string;
  isAdmin: boolean;
}) {
  const { budgets, error, reload } = useProjectBudgets(projectId);
  const [editing, setEditing] = useState<BudgetView | 'new'>();
  const [deleting, setDeleting] = useState<BudgetView>();
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/projects/${projectId}/budgets/${deleting.id}`, {
        method: 'DELETE',
      });
      toast.success('Budget deleted');
      setDeleting(undefined);
      await reload();
    } catch (err) {
      toast.error(describeBudgetsError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-prose text-sm text-ink-2">
          Spend is counted in API-equivalent dollars. A stop budget refuses new
          orchestrator starts and skill runs once it is used up; workers that
          are already running are never stopped.
          {isAdmin ? '' : ' Only a project admin can change budgets.'}
        </p>
        {isAdmin ? (
          <Button onClick={() => setEditing('new')}>New budget</Button>
        ) : null}
      </div>

      {error && !budgets ? (
        <p role="alert" className="text-sm text-danger">
          {describeBudgetsError(error)}
        </p>
      ) : !budgets ? (
        <Skeleton className="h-40 w-full" />
      ) : budgets.length === 0 ? (
        <EmptyState
          title="No budgets"
          description={
            isAdmin
              ? 'Add a daily, weekly or monthly limit to be notified, or to stop new spend.'
              : 'This project has no budget.'
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {budgets.map((budget) => (
            <BudgetCard
              key={budget.id}
              budget={budget}
              actions={
                isAdmin ? (
                  <>
                    <Button variant="glass" onClick={() => setEditing(budget)}>
                      Edit
                    </Button>
                    <Button variant="glass" onClick={() => setDeleting(budget)}>
                      Delete
                    </Button>
                  </>
                ) : undefined
              }
            />
          ))}
        </div>
      )}

      {isAdmin ? (
        <>
          <BudgetFormDialog
            open={editing !== undefined}
            budget={editing === 'new' ? undefined : editing}
            projectId={projectId}
            onClose={() => setEditing(undefined)}
            onSaved={() => {
              setEditing(undefined);
              toast.success('Budget saved');
              void reload();
            }}
          />
          <DialogRoot
            open={deleting !== undefined}
            onOpenChange={(open) => !open && !busy && setDeleting(undefined)}
          >
            <DialogContent
              title="Delete budget"
              description={
                deleting
                  ? `The ${PERIOD_LABEL[deleting.period].toLowerCase()} budget and its history are removed, and starts it refused are allowed again. This is audited.`
                  : undefined
              }
              footer={
                <>
                  <Button
                    variant="glass"
                    disabled={busy}
                    onClick={() => setDeleting(undefined)}
                  >
                    Cancel
                  </Button>
                  <Button disabled={busy} onClick={remove}>
                    {busy ? 'Deleting…' : 'Delete'}
                  </Button>
                </>
              }
            >
              <p className="text-sm text-ink-2">This cannot be undone.</p>
            </DialogContent>
          </DialogRoot>
        </>
      ) : null}
    </div>
  );
}
