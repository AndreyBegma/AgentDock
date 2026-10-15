'use client';

import {
  RUN_KINDS,
  RUN_UPDATED_LIVE_EVENT,
  type RunPage,
  type RunStatus,
  type RunSummary,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { ChipButton } from '@andrewbehma/glass-ui/chip';
import { type Column, DataTable } from '@andrewbehma/glass-ui/data-table';
import { DateInput } from '@andrewbehma/glass-ui/date-input';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Select } from '@andrewbehma/glass-ui/field';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { Toolbar } from '@andrewbehma/glass-ui/toolbar';
import NextLink from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '../../../../../components/page-header/page-header';
import { AsyncSection } from '../../../../../components/prerequisites/async-section';
import { ScrollX } from '../../../../../components/scroll-x/scroll-x';
import {
  isNotFound,
  PAGE_SIZE,
  queryString,
} from '../../../../../lib/activity/format';
import { api, describeErrorHint } from '../../../../../lib/api';
import {
  type UrlFilters,
  useFilterChips,
  useUrlFilters,
} from '../../../../../lib/filters/use-url-filters';
import { formatNumber } from '../../../../../lib/format';
import { Time } from '../../../../../lib/format/time';
import {
  abandonedHiddenLabel,
  costLabel,
  hasRunFilters,
  NO_RUN_FILTERS,
  parseRunUpdate,
  prLabel,
  RUN_CHIP_DEFS,
  RUN_FILTER_CODEC,
  RUN_KIND_LABEL,
  RUN_STATUS_CHIPS,
  RUN_STATUS_LABEL,
  type RunFilters,
  runTitle,
  runtimeLabel,
  splitAbandoned,
  tokensLabel,
  toRunQuery,
  totalRuns,
} from '../../../../../lib/history/format';
import { useLive } from '../../../../../lib/live/use-live';
import { useErrorToast } from '../../../../../lib/section/use-error-toast';
import { useSection } from '../../../../../lib/section/use-section';
import { formatDuration } from '../../../../../lib/sessions/format';
import { RUN_PILL_STATUS } from '../../../../../lib/status/pill';
import { ProjectRunnerBanner } from '../project-runner-banner';

/** Pushes arrive in bursts; one refetch covers them. */
const REFETCH_DEBOUNCE_MS = 300;

/** A selected filter chip wears the accent, not solid ink (#213). */
const SELECTED_CHIP = 'bg-accent-soft text-accent-ink';

/** Kind and dates: the canonical bar (#213), instant, in the URL. */
function HistoryFilters({ url }: { url: UrlFilters<RunFilters> }) {
  const { filters, set } = url;
  const chips = useFilterChips(url, RUN_CHIP_DEFS);
  return (
    <Toolbar
      aria-label="Filter runs"
      collapseBelow="sm"
      activeFilters={chips.activeFilters}
      onClearAll={chips.onClearAll}
      filters={
        <>
          <Select
            aria-label="Kind"
            value={filters.kind}
            className="w-full sm:w-44"
            onChange={(e) =>
              set({ kind: e.target.value as RunFilters['kind'] })
            }
          >
            <option value="">Any kind</option>
            {RUN_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {RUN_KIND_LABEL[kind]}
              </option>
            ))}
          </Select>
          <DateInput
            aria-label="Started from"
            value={filters.from}
            max={filters.to || undefined}
            className="w-full sm:w-40"
            onChange={(e) => set({ from: e.target.value })}
          />
          <DateInput
            aria-label="Started up to"
            value={filters.to}
            min={filters.from || undefined}
            className="w-full sm:w-40"
            onChange={(e) => set({ to: e.target.value })}
          />
        </>
      }
    />
  );
}

/** One dimension's counts — the status — as chips; a chip is a filter (#213). */
function StatusChips({
  counts,
  status,
  onChange,
}: {
  counts: Record<RunStatus, number>;
  status: RunFilters['status'];
  onChange: (status: RunFilters['status']) => void;
}) {
  const chip = (
    key: string,
    label: string,
    count: number,
    selected: boolean,
    value: RunFilters['status'],
  ) => (
    <ChipButton
      key={key}
      selected={selected}
      className={`shrink-0 ${selected ? SELECTED_CHIP : ''}`}
      onClick={() => onChange(value)}
    >
      {label} <Badge count={count} className="ml-1" />
    </ChipButton>
  );
  return (
    <fieldset className="m-0 mb-4 min-w-0 border-0 p-0">
      <legend className="sr-only">Filter by status</legend>
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
        {chip('all', 'All', totalRuns(counts), status === '', '')}
        {RUN_STATUS_CHIPS.map((s) =>
          chip(
            s,
            RUN_STATUS_LABEL[s],
            counts[s],
            status === s,
            status === s ? '' : s,
          ),
        )}
      </div>
    </fieldset>
  );
}

function HistoryView() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const url = useUrlFilters(RUN_FILTER_CODEC);
  const { filters, set } = url;
  const applied = useMemo(() => toRunQuery(filters), [filters]);
  /** Bumped by a live push; the list reloads. */
  const [version, setVersion] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showAbandoned, setShowAbandoned] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showError = useErrorToast();

  const base = `/projects/${projectId}/runs`;
  const query = queryString(applied, { limit: PAGE_SIZE });

  const runs = useSection(
    () => api<RunPage>(`${base}${query}`),
    [base, query, version],
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
          ...current,
          items: [
            ...current.items,
            ...page.items.filter((r) => !seen.has(r.id)),
          ],
          nextCursor: page.nextCursor,
        };
      });
    } catch (err) {
      showError(describeErrorHint(err));
    } finally {
      setLoadingMore(false);
    }
  };

  // Runtime and model ride under the title, and Kind is the eyebrow of the
  // run page, so the table fits the desk width without a clipped column.
  const columns = useMemo<Column<RunSummary>[]>(
    () => [
      {
        id: 'run',
        header: 'Run',
        cell: (run) => (
          <span className="flex min-w-48 flex-col">
            <NextLink
              href={`/projects/${projectId}/history/${run.id}`}
              className="underline-offset-2 hover:underline"
            >
              {runTitle(run)}
            </NextLink>
            <span className="text-xs text-ink-3">
              {RUN_KIND_LABEL[run.kind]}
              {runtimeLabel(run) !== '—' ? ` · ${runtimeLabel(run)}` : ''}
            </span>
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        cell: (run) => (
          <StatusPill
            size="md"
            status={RUN_PILL_STATUS[run.status]}
            label={RUN_STATUS_LABEL[run.status]}
          />
        ),
      },
      {
        id: 'pr',
        header: 'PR',
        cell: (run) => (
          <span className="whitespace-nowrap">{prLabel(run)}</span>
        ),
      },
      {
        id: 'duration',
        header: 'Duration',
        align: 'end',
        cell: (run) => (
          <span className="num whitespace-nowrap">
            {formatDuration(run.durationMs)}
          </span>
        ),
      },
      {
        id: 'tokens',
        header: 'Tokens',
        align: 'end',
        cell: (run) => <span className="num">{tokensLabel(run.usage)}</span>,
      },
      {
        id: 'cost',
        header: 'Cost',
        align: 'end',
        cell: (run) => (
          <span className="num whitespace-nowrap">{costLabel(run.usage)}</span>
        ),
      },
      {
        id: 'started',
        header: 'Started',
        cell: (run) => (
          <span className="whitespace-nowrap">
            <Time value={run.startedAt} />
          </span>
        ),
      },
    ],
    [projectId],
  );

  const filtered = hasRunFilters(filters);
  // Filtering for abandoned runs is asking to see them.
  const revealAbandoned = showAbandoned || filters.status === 'abandoned';

  if (runs.data === undefined && isNotFound(runs.error)) {
    return (
      <EmptyState
        title="Project not found"
        description="It does not exist, or you are not a member of it."
        link={NextLink}
        action={{ label: 'Open Projects', href: '/projects' }}
      />
    );
  }

  return (
    <>
      <PageHeader
        title="History"
        description="Every run of this project: worker slots, skills and schedules."
        className="mb-4"
      />
      <div className="mb-4">
        <ProjectRunnerBanner projectId={projectId} />
      </div>

      <div className="mb-4">
        <HistoryFilters url={url} />
      </div>

      {runs.data ? (
        <StatusChips
          counts={runs.data.counts}
          status={filters.status}
          onChange={(status) => set({ status })}
        />
      ) : null}

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
              action={{
                label: 'Clear filters',
                onClick: () => url.replace(NO_RUN_FILTERS),
              }}
            />
          ) : (
            <EmptyState
              title="No runs yet"
              description="A run is recorded when a worker slot, a skill or a schedule starts work. Start the orchestrator from Fleet to get the first one."
              link={NextLink}
              action={{
                label: 'Open Fleet',
                href: `/projects/${projectId}/fleet`,
              }}
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
        {(page) => {
          const { visible, hidden } = splitAbandoned(
            page.items,
            revealAbandoned,
          );
          return (
            <>
              {hidden > 0 || (showAbandoned && !filters.status) ? (
                <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-ink-2">
                  {hidden > 0
                    ? abandonedHiddenLabel(hidden)
                    : 'Showing abandoned runs'}
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    onClick={() => setShowAbandoned((show) => !show)}
                  >
                    {showAbandoned ? 'Hide' : 'Show'}
                  </Button>
                </div>
              ) : null}
              {visible.length === 0 ? (
                <EmptyState
                  title="Only abandoned runs so far"
                  description="Abandoned runs are hidden by default."
                />
              ) : (
                <ScrollX label="Runs">
                  <DataTable
                    rows={visible}
                    getRowId={(run) => run.id}
                    columns={columns}
                    onRowActivate={(run) =>
                      router.push(`/projects/${projectId}/history/${run.id}`)
                    }
                  />
                </ScrollX>
              )}
              {page.nextCursor ? (
                <div className="mt-4 flex flex-col items-center gap-1">
                  <Button
                    variant="glass"
                    disabled={loadingMore}
                    onClick={loadMore}
                  >
                    {loadingMore ? 'Loading…' : 'Load more'}
                  </Button>
                  <span className="text-xs text-ink-3">
                    {formatNumber(page.items.length)} of{' '}
                    {formatNumber(
                      filters.status
                        ? page.counts[filters.status]
                        : totalRuns(page.counts),
                    )}
                  </span>
                </div>
              ) : null}
            </>
          );
        }}
      </AsyncSection>
    </>
  );
}

export default function HistoryPage() {
  // `useSearchParams` needs a boundary for the static shell.
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <HistoryView />
    </Suspense>
  );
}
