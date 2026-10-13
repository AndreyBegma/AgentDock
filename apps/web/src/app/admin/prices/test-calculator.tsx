'use client';

import type { PriceTestRequest, PriceTestResponse } from '@agentdock/shared';
import { Button } from 'glass-ui/button';
import { Field, Input } from 'glass-ui/field';
import { toast } from 'glass-ui/toast';
import { type FormEvent, useState } from 'react';
import { DisabledReason } from '../../../components/prerequisites/disabled-reason';
import { api } from '../../../lib/api';
import {
  BUCKET_LABEL,
  NO_VERSION_REASON,
  TEST_BUCKETS,
} from '../../../lib/prices/format';
import { describeUsageError, formatUsd } from '../../../lib/usage/format';

/** Which price and tier the current version applies to a model id, and its cost. */
export function TestCalculator({ hasVersion }: { hasVersion: boolean }) {
  const [model, setModel] = useState('');
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [result, setResult] = useState<PriceTestResponse>();
  const [busy, setBusy] = useState(false);

  const run = async (event: FormEvent) => {
    event.preventDefault();
    const counts: PriceTestRequest['tokens'] = {};
    for (const bucket of TEST_BUCKETS) {
      const text = tokens[bucket]?.trim();
      if (!text) continue;
      const value = Number(text);
      if (!Number.isInteger(value) || value < 0) {
        toast.error(
          `${BUCKET_LABEL[bucket]} tokens must be a whole number, 0 or more.`,
        );
        return;
      }
      counts[bucket] = value;
    }
    setBusy(true);
    try {
      setResult(
        await api<PriceTestResponse>('/admin/prices/test', {
          method: 'POST',
          body: { model: model.trim(), tokens: counts },
        }),
      );
    } catch (err) {
      toast.error(describeUsageError(err));
    } finally {
      setBusy(false);
    }
  };

  const reason = !hasVersion
    ? NO_VERSION_REASON
    : model.trim() === ''
      ? 'Enter a model id to test, e.g. claude-sonnet-4-5-20250929.'
      : null;

  return (
    <section aria-labelledby="prices-test" className="mb-8">
      <h2 id="prices-test" className="mb-1 text-sm font-medium">
        Test calculator
      </h2>
      <p className="mb-3 text-xs text-ink-3">
        Which price and tier the <em>current</em> version applies to a model id,
        and what it costs. Save a draft as a new version to test its patterns.
      </p>
      <form
        onSubmit={run}
        className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        <Field label="Model id" htmlFor="test-model" required>
          <Input
            id="test-model"
            value={model}
            maxLength={200}
            placeholder="claude-sonnet-4-5-20250929"
            onChange={(e) => setModel(e.target.value)}
          />
        </Field>
        {TEST_BUCKETS.map((bucket) => (
          <Field
            key={bucket}
            label={`${BUCKET_LABEL[bucket]} tokens`}
            htmlFor={`test-${bucket}`}
          >
            <Input
              id={`test-${bucket}`}
              inputMode="numeric"
              value={tokens[bucket] ?? ''}
              onChange={(e) =>
                setTokens((current) => ({
                  ...current,
                  [bucket]: e.target.value,
                }))
              }
            />
          </Field>
        ))}
        <div className="flex flex-col gap-1">
          <div>
            <Button
              variant="glass"
              type="submit"
              disabled={busy || reason !== null}
              aria-describedby={reason ? 'test-reason' : undefined}
            >
              {busy ? 'Testing…' : 'Test'}
            </Button>
          </div>
          {reason ? (
            <DisabledReason id="test-reason">{reason}</DisabledReason>
          ) : null}
        </div>
      </form>
      {result ? (
        <p className="mt-3 text-sm" role="status">
          {result.modelName === null ? (
            <>
              No pattern matches — this request would be{' '}
              <strong>unpriced</strong>, not $0. Add a model whose pattern
              matches it.
            </>
          ) : (
            <>
              v{result.version} · <strong>{result.modelName}</strong> · tier{' '}
              <strong>{result.tier}</strong> · cost{' '}
              <strong>{formatUsd(result.costUsd) || '—'}</strong>
              {result.costUsd ? (
                <span className="text-ink-3"> ({result.costUsd} USD)</span>
              ) : null}
            </>
          )}
        </p>
      ) : null}
    </section>
  );
}
