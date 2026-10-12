'use client';

import {
  BUDGET_ACTIONS,
  BUDGET_PERIODS,
  type BudgetPeriod,
  type BudgetScope,
  type BudgetView,
} from '@agentdock/shared';
import { Button } from 'glass-ui/button';
import { Combobox } from 'glass-ui/combobox';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { Field, Input, Select } from 'glass-ui/field';
import { Toggle } from 'glass-ui/toggle';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import {
  ACTION_HINT,
  ACTION_LABEL,
  BUDGET_FORM_PROBLEM_TEXT,
  type BudgetForm,
  budgetFormProblem,
  describeBudgetsError,
  emptyBudgetForm,
  formFromBudget,
  isBudgetAction,
  PERIOD_LABEL,
  SCOPE_LABEL,
  toAdminCreateRequest,
  toCreateRequest,
  toUpdateRequest,
} from '../../lib/budgets/format';
import { browserTimezone, timezoneOptions } from '../../lib/schedules/format';

export interface TargetChoice {
  id: string;
  label: string;
}

/**
 * Creates or edits a budget (spec 28 UI). On a project's tab the project is
 * fixed (`projectId`); on `/admin/budgets` the admin also picks the scope and
 * its project or user. The API's 409/422 codes are shown as sentences and the
 * form stays open.
 */
export function BudgetFormDialog({
  open,
  budget,
  projectId,
  projects = [],
  users = [],
  onClose,
  onSaved,
}: {
  open: boolean;
  /** Set to edit; unset to create. */
  budget?: BudgetView;
  /** The project tab's own project; unset on the admin page. */
  projectId?: string;
  projects?: TargetChoice[];
  users?: TargetChoice[];
  onClose: () => void;
  onSaved: (saved: BudgetView) => void;
}) {
  const admin = projectId === undefined;
  const [form, setForm] = useState<BudgetForm>(() =>
    emptyBudgetForm(browserTimezone()),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setForm(
      budget ? formFromBudget(budget) : emptyBudgetForm(browserTimezone()),
    );
    setError(undefined);
  }, [open, budget]);

  const needsTarget = admin && !budget;
  const problem = budgetFormProblem(form, needsTarget);
  const set = <K extends keyof BudgetForm>(key: K, value: BudgetForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const zones = useMemo(
    () => timezoneOptions().map((name) => ({ value: name, label: name })),
    [],
  );
  const zoneOptions = useMemo(
    () =>
      form.timezone === '' || zones.some((z) => z.value === form.timezone)
        ? zones
        : [{ value: form.timezone, label: form.timezone }, ...zones],
    [zones, form.timezone],
  );
  const targets = form.scope === 'project' ? projects : users;
  const targetKey = form.scope === 'project' ? 'projectId' : 'userId';

  const close = () => {
    if (!busy) onClose();
  };

  const submit = async () => {
    if (problem) return;
    setBusy(true);
    setError(undefined);
    try {
      const base = admin ? '/admin/budgets' : `/projects/${projectId}/budgets`;
      let saved: BudgetView;
      if (budget) {
        const patch = toUpdateRequest(form, budget);
        if (Object.keys(patch).length === 0) {
          onClose();
          return;
        }
        saved = await api<BudgetView>(`${base}/${budget.id}`, {
          method: 'PATCH',
          body: patch,
        });
      } else {
        saved = await api<BudgetView>(base, {
          method: 'POST',
          body: admin ? toAdminCreateRequest(form) : toCreateRequest(form),
        });
      }
      onSaved(saved);
    } catch (err) {
      setError(describeBudgetsError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogRoot open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        title={budget ? 'Edit budget' : 'New budget'}
        description="The limit is in API-equivalent dollars. The period resets by itself in the chosen timezone."
        footer={
          <>
            <Button variant="glass" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button disabled={busy || problem !== null} onClick={submit}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {needsTarget ? (
            <>
              <Field label="Scope" htmlFor="budget-scope">
                <Select
                  id="budget-scope"
                  value={form.scope}
                  onChange={(e) =>
                    set(
                      'scope',
                      (e.target.value === 'user'
                        ? 'user'
                        : 'project') as BudgetScope,
                    )
                  }
                >
                  {(['project', 'user'] as const).map((scope) => (
                    <option key={scope} value={scope}>
                      {SCOPE_LABEL[scope]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label={form.scope === 'project' ? 'Project' : 'User'}
                htmlFor="budget-target"
                hint={
                  form.scope === 'user'
                    ? 'Counts skill runs and orchestrator sessions this user started; fleet workers are project-only.'
                    : undefined
                }
              >
                <Select
                  id="budget-target"
                  value={form[targetKey]}
                  onChange={(e) => set(targetKey, e.target.value)}
                >
                  <option value="">Choose…</option>
                  {targets.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          ) : null}

          <Field
            label="Period"
            htmlFor="budget-period"
            hint="Weeks start on Monday."
          >
            <Select
              id="budget-period"
              value={form.period}
              onChange={(e) =>
                set(
                  'period',
                  BUDGET_PERIODS.find((p) => p === e.target.value) ??
                    ('month' as BudgetPeriod),
                )
              }
            >
              {BUDGET_PERIODS.map((period) => (
                <option key={period} value={period}>
                  {PERIOD_LABEL[period]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Timezone" htmlFor="budget-timezone">
            <Combobox
              aria-label="Timezone"
              options={zoneOptions}
              value={form.timezone || null}
              placeholder="Europe/Berlin"
              onValueChange={(value) => set('timezone', value ?? '')}
            />
          </Field>

          <Field label="Limit (USD)" htmlFor="budget-limit">
            <Input
              id="budget-limit"
              inputMode="decimal"
              value={form.limit}
              placeholder="10"
              onChange={(e) => set('limit', e.target.value)}
            />
          </Field>

          <Field
            label="Thresholds (%)"
            htmlFor="budget-thresholds"
            hint="Each one sends one notification per period. 100 is always included."
          >
            <Input
              id="budget-thresholds"
              value={form.thresholds}
              onChange={(e) => set('thresholds', e.target.value)}
            />
          </Field>

          <Field
            label="When the limit is reached"
            htmlFor="budget-action"
            hint={ACTION_HINT[form.action]}
          >
            <Select
              id="budget-action"
              value={form.action}
              onChange={(e) => {
                const action = e.target.value;
                if (isBudgetAction(action)) set('action', action);
              }}
            >
              {BUDGET_ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {ACTION_LABEL[action]}
                </option>
              ))}
            </Select>
          </Field>

          <div className="flex items-center gap-2 text-sm">
            <Toggle
              labelledBy="budget-enabled"
              checked={form.enabled}
              onChange={(checked) => set('enabled', checked)}
            />
            <span id="budget-enabled">Enabled</span>
          </div>

          {problem && (problem !== 'limit' || form.limit !== '') ? (
            <p role="alert" className="text-sm text-danger">
              {BUDGET_FORM_PROBLEM_TEXT[problem]}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
