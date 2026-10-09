'use client';

import type { ModelPriceInput } from '@agentdock/shared';
import { Button } from 'glass-ui/button';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { Field, Input } from 'glass-ui/field';
import { type FormEvent, useEffect, useState } from 'react';
import {
  compilePattern,
  EMPTY_PRICE_FORM,
  formFromModel,
  modelFromForm,
  type PriceForm,
} from '../../../lib/usage/format';

const PRICE_FIELDS = [
  ['input', 'Input'],
  ['output', 'Output'],
  ['cacheRead', 'Cache read'],
  ['cacheWrite5m', 'Cache write (5 m)'],
  ['cacheWrite1h', 'Cache write (1 h)'],
  ['reasoning', 'Reasoning'],
] as const;

/** Whether `pattern` (case-insensitive regex) matches `sample`; null when either is unusable. */
function patternMatches(pattern: string, sample: string): boolean | null {
  if (!pattern || !sample) return null;
  try {
    return compilePattern(pattern).test(sample);
  } catch {
    return null;
  }
}

/**
 * Add or edit one model price. Editing rewrites the default tier's prices only
 * (other tiers are kept as they are). The sample check runs in the browser —
 * the API's `/admin/prices/test` only knows saved versions.
 */
export function ModelEditor({
  open,
  existing,
  onClose,
  onSave,
}: {
  open: boolean;
  existing: ModelPriceInput | undefined;
  onClose: () => void;
  onSave: (model: ModelPriceInput) => void;
}) {
  const [form, setForm] = useState<PriceForm>(EMPTY_PRICE_FORM);
  const [sample, setSample] = useState('');
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setForm(existing ? formFromModel(existing) : EMPTY_PRICE_FORM);
    setSample('');
    setError(undefined);
  }, [open, existing]);

  const patch = (change: Partial<PriceForm>) =>
    setForm((current) => ({ ...current, ...change }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = modelFromForm(form, existing);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSave(result.model);
  };

  const matches = patternMatches(form.matchPattern, sample);

  return (
    <DialogRoot open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={existing ? `Edit ${existing.modelName}` : 'Add a model'}
        description="USD per 1M tokens. A bucket left empty falls back to input."
      >
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field label="Model name" htmlFor="price-name">
            <Input
              id="price-name"
              value={form.modelName}
              maxLength={200}
              disabled={existing !== undefined}
              onChange={(e) => patch({ modelName: e.target.value })}
            />
          </Field>
          <Field
            label="Match pattern (regex, case-insensitive)"
            htmlFor="price-pattern"
          >
            <Input
              id="price-pattern"
              className="font-mono"
              value={form.matchPattern}
              maxLength={500}
              onChange={(e) => patch({ matchPattern: e.target.value })}
            />
          </Field>
          <Field label="Try a model id" htmlFor="price-sample">
            <Input
              id="price-sample"
              value={sample}
              maxLength={200}
              placeholder="e.g. claude-sonnet-4-5-20250929"
              onChange={(e) => setSample(e.target.value)}
            />
          </Field>
          {matches === null ? null : (
            <p className="text-xs text-ink-2" role="status">
              {matches
                ? 'The pattern matches this id.'
                : 'The pattern does not match this id.'}
            </p>
          )}
          <Field label="Priority (lower wins)" htmlFor="price-priority">
            <Input
              id="price-priority"
              inputMode="numeric"
              value={form.priority}
              onChange={(e) => patch({ priority: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {PRICE_FIELDS.map(([key, label]) => (
              <Field
                key={key}
                label={`${label} ($ / 1M)`}
                htmlFor={`price-${key}`}
              >
                <Input
                  id={`price-${key}`}
                  inputMode="decimal"
                  value={form[key]}
                  onChange={(e) => patch({ [key]: e.target.value })}
                />
              </Field>
            ))}
          </div>
          {existing && existing.tiers.length > 1 ? (
            <p className="text-xs text-ink-3">
              This model has {existing.tiers.length} tiers; only the default
              tier&apos;s prices are edited here, the others are kept.
            </p>
          ) : null}
          {error ? (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="solid" type="submit">
              Add to draft
            </Button>
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
