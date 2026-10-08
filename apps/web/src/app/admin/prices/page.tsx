'use client';

import type {
  CreatePriceVersionRequest,
  CurrentPricesResponse,
  ModelPriceInput,
  PriceTestRequest,
  PriceTestResponse,
  PriceVersionListResponse,
} from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Banner } from 'glass-ui/banner';
import { Button } from 'glass-ui/button';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { EmptyState } from 'glass-ui/empty-state';
import { Field, Input } from 'glass-ui/field';
import { Skeleton } from 'glass-ui/skeleton';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { toast } from 'glass-ui/toast';
import { useRouter } from 'next/navigation';
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { ApiError, api } from '../../../lib/api';
import {
  defaultTier,
  describeConditions,
  describeUsageError,
  formatPerMillion,
  formatTime,
  formatUsd,
} from '../../../lib/usage/format';
import { ModelEditor } from './model-editor';
import { RecomputeDialog } from './recompute-dialog';

const TEST_BUCKETS = [
  'input',
  'output',
  'cacheRead',
  'cacheWrite5m',
  'cacheWrite1h',
  'reasoning',
] as const;

type Draft = {
  upsert: Map<string, ModelPriceInput>;
  remove: Set<string>;
};

const emptyDraft = (): Draft => ({ upsert: new Map(), remove: new Set() });

function TestCalculator({ hasVersion }: { hasVersion: boolean }) {
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
        toast.error(`${bucket} must be a whole number, 0 or more.`);
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
        <Field label="Model id" htmlFor="test-model">
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
            label={`${bucket} tokens`}
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
        <div>
          <Button
            variant="glass"
            type="submit"
            disabled={busy || !model.trim() || !hasVersion}
          >
            {busy ? 'Testing…' : 'Test'}
          </Button>
        </div>
      </form>
      {result ? (
        <p className="mt-3 text-sm" role="status">
          {result.modelName === null ? (
            <>
              No pattern matches — this request would be{' '}
              <strong>unpriced</strong>, not $0.
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

function SaveDialog({
  open,
  draft,
  onClose,
  onSaved,
}: {
  open: boolean;
  draft: Draft;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (open) {
      setNote('');
      setError(undefined);
    }
  }, [open]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const body: CreatePriceVersionRequest = {
        note: note.trim(),
        upsert: [...draft.upsert.values()],
        remove: [...draft.remove],
      };
      await api('/admin/prices/versions', { method: 'POST', body });
      toast.success('New price version created. It is now current.');
      onSaved();
    } catch (err) {
      setError(describeUsageError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogRoot open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Save as a new version"
        description="The current version is cloned, your changes applied, and the result becomes current. Requests already priced keep their cost until you recompute."
      >
        <form onSubmit={save} className="flex flex-col gap-3">
          <p className="text-sm text-ink-2">
            {draft.upsert.size} added or changed · {draft.remove.size} removed
          </p>
          <Field label="Note" htmlFor="version-note">
            <Input
              id="version-note"
              value={note}
              maxLength={500}
              placeholder="What changed, and why"
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          {error ? (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="solid" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Create version'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}

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

  const load = useCallback(() => {
    Promise.all([
      api<CurrentPricesResponse>('/admin/prices'),
      api<PriceVersionListResponse>('/admin/prices/versions'),
    ])
      .then(([prices, list]) => {
        setCurrent(prices);
        setVersions(list);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          router.replace('/login');
        } else if (err instanceof ApiError && err.status === 403) {
          router.replace('/account');
        } else setError(describeUsageError(err));
      });
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

  if (error) {
    return (
      <Banner tone="danger" title="Could not load prices">
        {error}
      </Banner>
    );
  }

  const version = current?.version ?? null;

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Prices</h1>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="glass"
            onClick={() => setEditing({})}
            disabled={!version}
          >
            Add model
          </Button>
          <Button
            variant="glass"
            onClick={() => setRecomputing(true)}
            disabled={!version}
          >
            Recompute…
          </Button>
          <Button
            variant="solid"
            disabled={changes === 0}
            onClick={() => setSaving(true)}
          >
            Save new version{changes > 0 ? ` (${changes})` : ''}
          </Button>
        </div>
      </div>
      <p className="mb-4 text-sm text-ink-3">
        Prices are versions: editing creates a new one cloned from the current
        version. Requests keep the cost they were priced with until you
        recompute a range.
      </p>

      {!current ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : !version ? (
        <EmptyState
          title="No price version yet"
          description="Run the database seed to create version 1 from the vendored Langfuse snapshot."
        />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
            <Badge tone="ok" label={`Current: v${version.number}`} />
            <span className="text-ink-2">
              {version.source} · {formatTime(version.createdAt)} ·{' '}
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
              <EmptyState
                title="No models"
                description="Nothing matches the filter."
              />
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
                      <TableCell>{v.source}</TableCell>
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
