'use client';

import {
  RUN_KINDS,
  RUN_STATUSES,
  RUN_UPDATED_LIVE_EVENT,
  type RunListQuery,
  type RunPage,
  type RunSummary,
} from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Button } from 'glass-ui/button';
import { type Column, DataTable } from 'glass-ui/data-table';
import { DateInput } from 'glass-ui/date-input';
import { EmptyState } from 'glass-ui/empty-state';
import { Field, Select } from 'glass-ui/field';
import { toast } from 'glass-ui/toast';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { AsyncSection } from '../../../../../components/prerequisites/async-section';
import {
  isNotFound,
  PAGE_SIZE,
  queryString,
} from '../../../../../lib/activity/format';
import { api, describeError } from '../../../../../lib/api';
import { formatAgo } from '../../../../../lib/fleet/format';
import {
  costLabel,
  EMPTY_RUN_FILTERS,
  hasRunFilters,
  parseRunUpdate,
  prLabel,
  RUN_KIND_LABEL,
  RUN_STATUS_LABEL,
  RUN_STATUS_TONE,
  type RunFilterForm,
  runFiltersDirty,
  runFiltersFromKind,
  runLabel,
  runtimeLabel,
  tokensLabel,
  toRunQuery,
} from '../../../../../lib/history/format';
import { useLive } from '../../../../../lib/live/use-live';
import { useSection } from '../../../../../lib/section/use-section';
import { formatDuration } from '../../../../../lib/sessions/format';
import { ProjectRunnerBanner } from '../project-runner-banner';

/** Pushes arrive in bursts; one refetch covers them. */
const REFETCH_DEBOUNCE_MS = 300;

export default function HistoryPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const [form, setForm] = useState<RunFilterForm>(EMPTY_RUN_FILTERS);
  const [applied, setApplied] = useState<RunListQuery>({});
  /** Bumped by a live push; the list reloads. */
  const [version, setVersion] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const base = `/projects/${projectId}/runs`;

  // A link may carry the kind (`?kind=skill`, from the Skills page).
  useEffect(() => {
    const kind = new URLSearchParams(window.location.search).get('kind');
    if (kind === null) return;
    const next = runFiltersFromKind(kind);
    setForm(next);
    setApplied(toRunQuery(next));
  }, []);

  const runs = useSection(
    () => api<RunPage>(`${base}${queryString(applied, { limit: PAGE_SIZE })}`),
    [base, applied, version],
  );

  useLive(`project:${projectId}`, (message) => {
    if (message.event !== RUN_UPDATED_LIVE_EVENT) return;
    if (!parseRunUpdate(message.data)) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setVersion((v) => v + 1),
      REFETCH_DEBOUNCE_MS,
    );
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  const loadMore = async () => {
    const cursor = runs.data?.nextCursor;
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await api<RunPage>(
        `${base}${queryString(applied, { cursor, limit: PAGE_SIZE })}`,
      );
      runs.setData((current) => {
        if (!current) return current;
        const seen = new Set(current.items.map((r) => r.id));
        return {
          items: [
            ...current.items,
            ...page.items.filter((r) => !seen.has(r.id)),
          ],
          nextCursor: page.nextCursor,
        };
      });
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const columns = useMemo<Column<RunSummary>[]>(
    () => [
      {
        id: 'run',
        header: 'Run',
        cell: (run) => (
          <Link
            href={`/projects/${projectId}/history/${run.id}`}
            className="underline-offset-2 hover:underline"
          >
            {runLabel(run)}
          </Link>
        ),
      },
      {
        id: 'kind',
        header: 'Kind',
        cell: (run) => RUN_KIND_LABEL[run.kind],
      },
      {
        id: 'runtime',
        header: 'Runtime / model',
        cell: (run) => runtimeLabel(run),
      },
      {
        id: 'status',
        header: 'Status',
        cell: (run) => (
          <Badge
            tone={RUN_STATUS_TONE[run.status]}
            label={RUN_STATUS_LABEL[run.status]}
          />
        ),
      },
      { id: 'pr', header: 'PR', cell: (run) => prLabel(run) },
      {
        id: 'duration',
        header: 'Duration',
        align: 'end',
        cell: (run) => formatDuration(run.durationMs),
      },
      {
        id: 'tokens',
        header: 'Tokens',
        align: 'end',
        cell: (run) => tokensLabel(run.usage),
      },
      {
        id: 'cost',
        header: 'Cost',
        align: 'end',
        cell: (run) => costLabel(run.usage),
      },
      {
        id: 'started',
        header: 'Started',
        cell: (run) => (
          <span title={new Date(run.startedAt).toLocaleString()}>
            {formatAgo(run.startedAt)}
          </span>
        ),
      },
    ],
    [projectId],
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setApplied(toRunQuery(form));
  };

  const reset = () => {
    setForm(EMPTY_RUN_FILTERS);
    setApplied({});
  };

  const dirty = runFiltersDirty(form, applied);
  const filtered = Object.keys(applied).length > 0;

  if (runs.data === undefined && isNotFound(runs.error)) {
    return (
      <EmptyState
        title="Project not found"
        description="It does not exist, or you are not a member of it."
        action={
          <Link href="/projects" className="text-sm underline">
            Open Projects
          </Link>
        }
      />
    );
  }

  return (
    <>
      <h1 className="mb-4 text-xl font-semibold">History</h1>
      <div className="mb-4">
        <ProjectRunnerBanner projectId={projectId} />
      </div>

      <form
        onSubmit={submit}
        className="mb-6 grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-5"
      >
        <Field label="Kind" htmlFor="history-kind">
          <Select
            id="history-kind"
            value={form.kind}
            onChange={(e) => setForm((c) => ({ ...c, kind: e.target.value }))}
          >
            <option value="">Any kind</option>
            {RUN_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {RUN_KIND_LABEL[kind]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status" htmlFor="history-status">
          <Select
            id="history-status"
            value={form.status}
            onChange={(e) => setForm((c) => ({ ...c, status: e.target.value }))}
          >
            <option value="">Any status</option>
            {RUN_STATUSES.map((status) => (
              <option key={status} value={status}>
                {RUN_STATUS_LABEL[status]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="From" htmlFor="history-from">
          <DateInput
            id="history-from"
            value={form.fromDate}
            max={form.toDate || undefined}
            onChange={(e) =>
              setForm((c) => ({ ...c, fromDate: e.target.value }))
            }
          />
        </Field>
        <Field label="To" htmlFor="history-to">
          <DateInput
            id="history-to"
            value={form.toDate}
            min={form.fromDate || undefined}
            onChange={(e) => setForm((c) => ({ ...c, toDate: e.target.value }))}
          />
        </Field>
        <div className="flex flex-col gap-1">
          <div className="flex gap-2">
            <Button variant="solid" type="submit">
              Apply
            </Button>
            <Button
              variant="ghost"
              type="button"
              disabled={!hasRunFilters(form) && !filtered}
              onClick={reset}
            >
              Reset
            </Button>
          </div>
          {dirty ? (
            <p role="status" className="text-xs text-warn">
              Filters changed. Apply to update the list.
            </p>
          ) : null}
        </div>
      </form>

      <AsyncSection
        section={runs}
        unavailable={{
          title: 'History could not be loaded',
          stillWorks: 'Fleet and queue are still available.',
        }}
        isEmpty={(page) => page.items.length === 0}
        empty={
          filtered ? (
            <EmptyState
              title="No matching runs"
              description="No run matches these filters."
              action={
                <Button variant="glass" onClick={reset}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No runs yet"
              description="A run is recorded when a worker slot, a skill or a schedule starts work. Start the orchestrator from Fleet to get the first one."
              action={
                <Link
                  href={`/projects/${projectId}/fleet`}
                  className="text-sm underline"
                >
                  Open Fleet
                </Link>
              }
            />
          )
        }
        skeleton={
          <DataTable
            rows={[]}
            getRowId={(run: RunSummary) => run.id}
            columns={columns}
            loading
          />
        }
      >
        {(page) => (
          <>
            <DataTable
              rows={page.items}
              getRowId={(run) => run.id}
              columns={columns}
              onRowActivate={(run) =>
                router.push(`/projects/${projectId}/history/${run.id}`)
              }
            />
            {page.nextCursor ? (
              <div className="mt-4 flex justify-center">
                <Button
                  variant="glass"
                  disabled={loadingMore}
                  onClick={loadMore}
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </AsyncSection>
    </>
  );
}
