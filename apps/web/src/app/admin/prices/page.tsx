'use client';

import type {
  CurrentPricesResponse,
  ModelPriceInput,
  PriceVersionListResponse,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { CodeBlock } from '@andrewbehma/glass-ui/code-block';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Field, Input } from '@andrewbehma/glass-ui/field';
import { SectionUnavailable } from '@andrewbehma/glass-ui/section-unavailable';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { DisabledReason } from '../../../components/prerequisites/disabled-reason';
import { ApiError, api } from '../../../lib/api';
import {
  NO_VERSION_REASON,
  PRICES_SEED_COMMAND,
  SOURCE_LABEL,
} from '../../../lib/prices/format';
import {
  defaultTier,
  describeConditions,
  describeUsageError,
  formatPerMillion,
  formatTime,
} from '../../../lib/usage/format';
import { ModelEditor } from './model-editor';
import { RecomputeDialog } from './recompute-dialog';
import { type Draft, emptyDraft, SaveDialog } from './save-dialog';
import { TestCalculator } from './test-calculator';

export default function AdminPricesPage() {
  const router = useRouter();
  const [current, setCurrent] = useState<CurrentPricesResponse>();
  const [versions, setVersions] = useState<PriceVersionListResponse>();
  const [filter, setFilter] = useState('');
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editing, setEditing] = useState<{ model?: ModelPriceInput }>();
  const [saving, setSaving] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<CurrentPricesResponse>('/admin/prices'),
      api<PriceVersionListResponse>('/admin/prices/versions'),
    ])
      .then(([prices, list]) => {
        setCurrent(prices);
        setVersions(list);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          router.replace('/login');
        } else if (err instanceof ApiError && err.status === 403) {
          router.replace('/account');
        } else setError(describeUsageError(err));
      })
      .finally(() => setLoading(false));
  }, [router]);

  useEffect(load, [load]);

  const models = useMemo(() => {
    // The draft shows over the saved list: changed models in place, new ones first.
    const saved = current?.models ?? [];
    const savedNames = new Set(saved.map((m) => m.modelName));
    const added = [...draft.upsert.values()].filter(
      (m) => !savedNames.has(m.modelName),
    );
    const merged = [
      ...added,
      ...saved.map((m) => draft.upsert.get(m.modelName) ?? m),
    ];
    const needle = filter.trim().toLowerCase();
    return needle
      ? merged.filter(
          (m) =>
            m.modelName.toLowerCase().includes(needle) ||
            m.matchPattern.toLowerCase().includes(needle),
        )
      : merged;
  }, [current, draft, filter]);

  const savedByName = useMemo(
    () => new Map((current?.models ?? []).map((m) => [m.modelName, m])),
    [current],
  );

  const changes = draft.upsert.size + draft.remove.size;

  const upsert = (model: ModelPriceInput) => {
    setDraft((d) => {
      const next = { upsert: new Map(d.upsert), remove: new Set(d.remove) };
      next.upsert.set(model.modelName, model);
      next.remove.delete(model.modelName);
      return next;
    });
    setEditing(undefined);
  };

  const toggleRemove = (name: string) =>
    setDraft((d) => {
      const next = { upsert: new Map(d.upsert), remove: new Set(d.remove) };
      if (next.remove.has(name)) next.remove.delete(name);
      else {
        next.remove.add(name);
        next.upsert.delete(name);
      }
      return next;
    });

  const version = current?.version ?? null;
  // Rule R1: a reason only once the page knows there is no version.
  const versionReason = current && !version ? NO_VERSION_REASON : null;

  return (
    <>
      <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-xl font-semibold">Prices</h1>
        <div className="flex flex-col items-end gap-1">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="glass"
              onClick={() => setEditing({})}
              disabled={!version}
              aria-describedby={versionReason ? 'prices-reason' : undefined}
            >
              Add model
            </Button>
            <Button
              variant="glass"
              onClick={() => setRecomputing(true)}
              disabled={!version}
              aria-describedby={versionReason ? 'prices-reason' : undefined}
            >
              Re-price requests…
            </Button>
            <Button
              variant="solid"
              disabled={changes === 0}
              aria-describedby={
                changes === 0 ? 'prices-save-reason' : undefined
              }
              onClick={() => setSaving(true)}
            >
              Save new version{changes > 0 ? ` (${changes})` : ''}
            </Button>
          </div>
          {versionReason ? (
            <DisabledReason id="prices-reason">{versionReason}</DisabledReason>
          ) : version && changes === 0 ? (
            <DisabledReason id="prices-save-reason">
              Add, edit or remove a model to save a new version.
            </DisabledReason>
          ) : null}
        </div>
      </div>
      <p className="mb-1 text-sm text-ink-3">
        Prices are versions: editing creates a new one cloned from the current
        version. Requests keep the cost they were priced with until you re-price
        a range.
      </p>
      <p className="mb-4 text-xs text-ink-3">
        Re-price requests changes stored costs. Budgets add those costs up
        separately: after re-pricing, run{' '}
        <Link
          href="/admin/budgets"
          className="text-ink underline underline-offset-2"
        >
          Recompute budget totals under Budgets
        </Link>
        .
      </p>

      {error ? (
        <div className="mb-4">
          <SectionUnavailable
            title="Prices are not answering"
            stillWorks={
              current
                ? 'What is shown below may be out of date. New requests are still priced on the server.'
                : 'New requests are still priced on the server.'
            }
            detail={error}
            action={
              <Button
                variant="glass"
                size="sm"
                disabled={loading}
                onClick={load}
              >
                Try again
              </Button>
            }
          />
        </div>
      ) : null}

      {!current ? (
        error ? null : (
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-6 w-64" />
            <Skeleton className="h-40 w-full" />
          </div>
        )
      ) : !version ? (
        <EmptyState
          title="No price version yet"
          description="Without one, every request is unpriced and budgets cannot count it. Seed version 1 from the bundled Langfuse price list: run this in the AgentDock checkout, with the API’s database settings in apps/api/.env."
          action={<CodeBlock code={PRICES_SEED_COMMAND} />}
        />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
            <Badge tone="ok" label={`Current: v${version.number}`} />
            <span className="text-ink-2">
              {SOURCE_LABEL[version.source]} · {formatTime(version.createdAt)} ·{' '}
              {version.models} models
              {version.note ? ` · ${version.note}` : ''}
            </span>
          </div>

          <div className="mb-3 max-w-sm">
            <Field label="Filter models" htmlFor="prices-filter">
              <Input
                id="prices-filter"
                value={filter}
                maxLength={100}
                placeholder="Name or pattern"
                onChange={(e) => setFilter(e.target.value)}
              />
            </Field>
          </div>

          <div className="mb-8">
            {models.length === 0 ? (
              filter.trim() !== '' ? (
                <EmptyState
                  title="No model matches the filter"
                  description="Other models are hidden by the name or pattern filter."
                  action={
                    <Button variant="glass" onClick={() => setFilter('')}>
                      Clear filter
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  title="Models this version prices"
                  description="This version prices no model, so every request is unpriced. Add one."
                  action={
                    <Button variant="glass" onClick={() => setEditing({})}>
                      Add model
                    </Button>
                  }
                />
              )
            ) : (
              <Table scroll>
                <TableHead>
                  <TableRow>
                    <TableCell head>Model</TableCell>
                    <TableCell head>Pattern</TableCell>
                    <TableCell head>Priority</TableCell>
                    <TableCell head>Input / 1M</TableCell>
                    <TableCell head>Output / 1M</TableCell>
                    <TableCell head>Cache read / 1M</TableCell>
                    <TableCell head>Tiers</TableCell>
                    <TableCell head>
                      <span className="sr-only">Actions</span>
                    </TableCell>
                  </TableRow>
                </TableHead>
                <tbody>
                  {models.map((model) => {
                    const prices = defaultTier(model)?.prices;
                    const removed = draft.remove.has(model.modelName);
                    const changed = draft.upsert.has(model.modelName);
                    return (
                      <TableRow key={model.modelName}>
                        <TableCell>
                          <span
                            className={removed ? 'line-through' : undefined}
                          >
                            {model.modelName}
                          </span>{' '}
                          {removed ? (
                            <Badge tone="danger" label="removed" />
                          ) : null}
                          {changed ? (
                            <Badge
                              tone="warn"
                              label={
                                savedByName.has(model.modelName)
                                  ? 'edited'
                                  : 'new'
                              }
                            />
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <code className="font-mono text-xs">
                            {model.matchPattern}
                          </code>
                        </TableCell>
                        <TableCell>{model.priority}</TableCell>
                        <TableCell>{formatPerMillion(prices?.input)}</TableCell>
                        <TableCell>
                          {formatPerMillion(prices?.output)}
                        </TableCell>
                        <TableCell>
                          {formatPerMillion(prices?.cacheRead)}
                        </TableCell>
                        <TableCell>
                          {model.tiers.length > 1
                            ? model.tiers
                                .filter((t) => !t.isDefault)
                                .map(
                                  (t) => `${t.name}: ${describeConditions(t)}`,
                                )
                                .join('; ')
                            : '—'}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="glass"
                              size="sm"
                              aria-label={`Edit ${model.modelName}`}
                              disabled={removed}
                              onClick={() => setEditing({ model })}
                            >
                              Edit
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`${removed ? 'Keep' : 'Remove'} ${model.modelName}`}
                              onClick={() => toggleRemove(model.modelName)}
                            >
                              {removed ? 'Keep' : 'Remove'}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </tbody>
              </Table>
            )}
            {changes > 0 ? (
              <div className="mt-3 flex items-center gap-3 text-sm text-ink-2">
                Draft: {draft.upsert.size} changed, {draft.remove.size} removed.
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDraft(emptyDraft())}
                >
                  Discard draft
                </Button>
              </div>
            ) : null}
          </div>

          <TestCalculator hasVersion />

          <section aria-labelledby="prices-history">
            <h2 id="prices-history" className="mb-2 text-sm font-medium">
              Version history
            </h2>
            {versions ? (
              <Table scroll>
                <TableHead>
                  <TableRow>
                    <TableCell head>Version</TableCell>
                    <TableCell head>Source</TableCell>
                    <TableCell head>Created</TableCell>
                    <TableCell head>By</TableCell>
                    <TableCell head>Models</TableCell>
                    <TableCell head>Note</TableCell>
                  </TableRow>
                </TableHead>
                <tbody>
                  {versions.versions.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell>
                        v{v.number}{' '}
                        {v.id === version.id ? (
                          <Badge tone="ok" label="current" />
                        ) : null}
                      </TableCell>
                      <TableCell>{SOURCE_LABEL[v.source]}</TableCell>
                      <TableCell>{formatTime(v.createdAt)}</TableCell>
                      <TableCell>{v.createdBy?.email ?? '—'}</TableCell>
                      <TableCell>{v.models}</TableCell>
                      <TableCell>{v.note ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </tbody>
              </Table>
            ) : null}
          </section>
        </>
      )}

      <ModelEditor
        open={editing !== undefined}
        existing={editing?.model}
        onClose={() => setEditing(undefined)}
        onSave={upsert}
      />
      <SaveDialog
        open={saving}
        draft={draft}
        onClose={() => setSaving(false)}
        onSaved={() => {
          setSaving(false);
          setDraft(emptyDraft());
          load();
        }}
      />
      <RecomputeDialog
        open={recomputing}
        versions={versions?.versions ?? []}
        currentId={version?.id}
        onClose={() => setRecomputing(false)}
        onFinished={load}
      />
    </>
  );
}
