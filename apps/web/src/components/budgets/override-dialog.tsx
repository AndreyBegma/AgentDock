'use client';

import { BUDGET_OVERRIDE_REASON_MAX, type BudgetView } from '@agentdock/shared';
import { Button } from 'glass-ui/button';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { Field, Input, Textarea } from 'glass-ui/field';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import {
  describeBudgetsError,
  formatMoment,
  OVERRIDE_PROBLEM_TEXT,
  type OverrideForm,
  overrideProblem,
  scopeName,
  toLocalInput,
  toOverrideRequest,
} from '../../lib/budgets/format';

/**
 * Lifts a stop budget until a time inside the current period (spec 28 D8).
 * The reason is audited; the API refuses an `alert` budget and a time past the
 * period's end, and its answer is shown here as a sentence.
 */
export function OverrideDialog({
  budget,
  onClose,
  onSaved,
}: {
  budget: BudgetView | undefined;
  onClose: () => void;
  onSaved: (saved: BudgetView) => void;
}) {
  const [form, setForm] = useState<OverrideForm>({ until: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const end = budget?.current?.end;
  useEffect(() => {
    if (!budget) return;
    // Default to the period's end: the override lasts as long as the stop would.
    setForm({
      until: end ? toLocalInput(new Date(end)) : '',
      reason: '',
    });
    setError(undefined);
  }, [budget, end]);

  const problem = budget ? overrideProblem(form, budget) : null;
  const close = () => {
    if (!busy) onClose();
  };

  const submit = async () => {
    if (!budget || problem) return;
    setBusy(true);
    setError(undefined);
    try {
      onSaved(
        await api<BudgetView>(`/admin/budgets/${budget.id}/override`, {
          method: 'POST',
          body: toOverrideRequest(form),
        }),
      );
    } catch (err) {
      setError(describeBudgetsError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogRoot open={budget !== undefined} onOpenChange={(o) => !o && close()}>
      <DialogContent
        title="Override budget"
        description={
          budget
            ? `Lets new starts through for ${scopeName(budget)} until the time below. It never outlives the period${end ? ` (ends ${formatMoment(end, budget.timezone)}, ${budget.timezone})` : ''}.`
            : undefined
        }
        footer={
          <>
            <Button variant="glass" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button disabled={busy || problem !== null} onClick={submit}>
              {busy ? 'Saving…' : 'Override'}
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
          <Field
            label="Until (your local time)"
            htmlFor="budget-override-until"
          >
            <Input
              id="budget-override-until"
              type="datetime-local"
              value={form.until}
              onChange={(e) =>
                setForm((f) => ({ ...f, until: e.target.value }))
              }
            />
          </Field>
          <Field
            label="Reason"
            htmlFor="budget-override-reason"
            hint={`Audited with the override. ${form.reason.length} / ${BUDGET_OVERRIDE_REASON_MAX}`}
          >
            <Textarea
              id="budget-override-reason"
              rows={3}
              value={form.reason}
              onChange={(e) =>
                setForm((f) => ({ ...f, reason: e.target.value }))
              }
            />
          </Field>
          {problem && (problem !== 'reason' || form.reason !== '') ? (
            <p role="alert" className="text-sm text-danger">
              {OVERRIDE_PROBLEM_TEXT[problem]}
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
