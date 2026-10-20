'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { toast } from '@andrewbehma/glass-ui/toast';
import type { AdminUser, ProjectSummary } from '@nautelle/shared';
import { useEffect, useState } from 'react';
import { BudgetFormDialog } from '../../../components/budgets/budget-form-dialog';
import { DisabledReason } from '../../../components/prerequisites/disabled-reason';
import { api } from '../../../lib/api';

/**
 * "Set a budget" (#213) — the page's one primary. With a project in view it
 * sets that project's budget; an administrator with none picks the project
 * or user in the dialog, as on Admin › Budgets. Anyone else picks a project
 * first: a budget always has a scope.
 */
export function SetBudget({
  projectId,
  projects,
  isAdmin,
  onSaved,
}: {
  projectId: string;
  projects: ProjectSummary[];
  isAdmin: boolean;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const adminMode = !projectId && isAdmin;
  const enabled = projectId !== '' || isAdmin;

  useEffect(() => {
    if (!open || !adminMode) return;
    api<AdminUser[]>('/admin/users?status=active')
      .then((list) => {
        if (Array.isArray(list)) setUsers(list);
      })
      .catch(() => {
        // The dialog still offers every project; a user budget waits.
      });
  }, [open, adminMode]);

  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <Button
        variant="solid"
        disabled={!enabled}
        aria-describedby={enabled ? undefined : 'usage-budget-reason'}
        onClick={() => setOpen(true)}
      >
        Set a budget
      </Button>
      {enabled ? null : (
        <DisabledReason id="usage-budget-reason">
          Pick a project to set its budget.
        </DisabledReason>
      )}
      <BudgetFormDialog
        open={open}
        projectId={adminMode ? undefined : projectId}
        projects={projects.map((p) => ({ id: p.id, label: p.displayName }))}
        users={users.map((u) => ({ id: u.id, label: u.name ?? u.email }))}
        onClose={() => setOpen(false)}
        onSaved={() => {
          setOpen(false);
          toast.success('Budget saved');
          onSaved();
        }}
      />
    </div>
  );
}
