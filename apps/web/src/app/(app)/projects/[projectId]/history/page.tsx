'use client';

import {
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
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
  parseRunUpdate,
  prLabel,
  RUN_STATUS_LABEL,
  RUN_STATUS_TONE,
  type RunFilterForm,
  runLabel,
  runtimeLabel,
  tokensLabel,
  toRunQuery,
} from '../../../../../lib/history/format';
import { useLive } from '../../../../../lib/live/use-live';
import { formatDuration } from '../../../../../lib/sessions/format';

/** Pushes arrive in bursts; one refetch covers them. */
const REFETCH_DEBOUNCE_MS = 300;

export default function HistoryPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const [form, setForm] = useState<RunFilterForm>(EMPTY_RUN_FILTERS);
  const [applied, setApplied] = useState<RunListQuery>({});
  const [runs, setRuns] = useState<RunSummary[]>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [missing, setMissing] = useState(false);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const base = `/projects/${projectId}/runs`;

  const load = useCallback(
    async (query: RunListQuery) => {
      const mine = ++generation.current;
      try {
        const page = await api<RunPage>(
          `${base}${queryString(query, { limit: PAGE_SIZE })}`,
        );
        if (mine !== generation.current) return;
        setMissing(false);
        setRuns(page.items);
        setNextCursor(page.nextCursor);
      } catch (err) {
        if (mine !== generation.current) return;
        if (isNotFound(err)) setMissing(true);
        else toast.error(describeError(err));
        setRuns((current) => current ?? []);
      }
    },
    [base],
  );

  useEffect(() => {
    setRuns(undefined);
    load(applied);
  }, [applied, load]);

  const appliedRef = useRef(applied);
  appliedRef.current = applied;
  useLive(`project:${projectId}`, (message) => {
    if (message.event !== RUN_UPDATED_LIVE_EVENT) return;
    if (!parseRunUpdate(message.data)) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => load(appliedRef.current),
      REFETCH_DEBOUNCE_MS,
    );
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api<RunPage>(
        `${base}${queryString(applied, { cursor: nextCursor, limit: PAGE_SIZE })}`,
      );
      setRuns((current) => {
        const seen = new Set((current ?? []).map((r) => r.id));
        return [
          ...(current ?? []),
          ...page.items.filter((r) => !seen.has(r.id)),
        ];
      });
      setNextCursor(page.nextCursor);
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
      { id: 'kind', header: 'Kind', cell: (run) => run.kind.replace('_', ' ') },
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

  return (
    <>
      <h1 className="mb-4 text-xl font-semibold">History</h1>

      <form
        onSubmit={submit}
        className="mb-6 grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
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
        <div className="flex gap-2">
          <Button variant="solid" type="submit">
            Apply
          </Button>
          <Button
            variant="ghost"
            type="button"
            onClick={() => {
              setForm(EMPTY_RUN_FILTERS);
              setApplied({});
            }}
          >
            Reset
          </Button>
        </div>
      </form>

      {missing ? (
        <EmptyState
          title="Project not found"
          description="It does not exist, or you are not a member of it."
        />
      ) : (
        <>
          <DataTable
            rows={runs ?? []}
            getRowId={(run) => run.id}
            columns={columns}
            loading={runs === undefined}
            onRowActivate={(run) =>
              router.push(`/projects/${projectId}/history/${run.id}`)
            }
            emptyState={
              <EmptyState
                title="No runs"
                description="Nothing matches these filters, or no slot has run yet."
              />
            }
          />
          {nextCursor ? (
            <div className="mt-4 flex justify-center">
              <Button variant="glass" disabled={loadingMore} onClick={loadMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
