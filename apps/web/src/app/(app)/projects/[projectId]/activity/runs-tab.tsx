'use client';

import {
  RUN_KINDS,
  RUN_STATUSES,
  RUN_UPDATED_LIVE_EVENT,
  type RunPage,
  type RunStatus,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { ChipButton } from '@andrewbehma/glass-ui/chip';
import { DateInput } from '@andrewbehma/glass-ui/date-input';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Select } from '@andrewbehma/glass-ui/field';
import { ListDetail } from '@andrewbehma/glass-ui/list-detail';
import { SheetContent, SheetRoot } from '@andrewbehma/glass-ui/sheet';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { Timeline } from '@andrewbehma/glass-ui/timeline';
import { Toolbar } from '@andrewbehma/glass-ui/toolbar';
import { useBreakpoint } from '@andrewbehma/glass-ui/use-breakpoint';
import NextLink from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AsyncSection } from '../../../../../components/prerequisites/async-section';
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
import {
  abandonedHiddenLabel,
  hasRunFilters,
  NO_RUN_FILTERS,
  parseRunUpdate,
  RUN_CHIP_DEFS,
  RUN_FILTER_CODEC,
  RUN_KIND_LABEL,
  RUN_STATUS_CHIPS,
  RUN_STATUS_LABEL,
  RUN_STATUS_TONE,
  type RunFilters,
  runFacts,
  runTitle,
  splitAbandoned,
  toRunQuery,
  totalRuns,
} from '../../../../../lib/history/format';
import { useLive } from '../../../../../lib/live/use-live';
import { useErrorToast } from '../../../../../lib/section/use-error-toast';
import { useSection } from '../../../../../lib/section/use-section';
import { RUN_PILL_STATUS } from '../../../../../lib/status/pill';
import { RunDetailPane } from './run-detail';

/** Pushes arrive in bursts; one refetch covers them. */
const REFETCH_DEBOUNCE_MS = 300;

/** A selected filter chip wears the accent, not solid ink (#213). */
const SELECTED_CHIP = 'bg-accent-soft text-accent-ink';

const isRunStatus = (value: string): value is RunStatus =>
  (RUN_STATUSES as readonly string[]).includes(value);

/**
 * Kind and dates: the canonical bar (#213), instant, in the URL. On a phone
 * the bar folds into one "Filters" control, and status joins it there, since
 * its row of chips is left out below the tablet edge.
 */
function RunFiltersBar({ url }: { url: UrlFilters<RunFilters> }) {
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
            aria-label="Status"
            value={filters.status}
            className="w-full sm:hidden"
            onChange={(e) =>
              set({
                status: isRunStatus(e.target.value) ? e.target.value : '',
              })
            }
          >
            <option value="">Any status</option>
            {RUN_STATUS_CHIPS.map((status) => (
              <option key={status} value={status}>
                {RUN_STATUS_LABEL[status]}
              </option>
            ))}
          </Select>
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
    <fieldset className="m-0 mb-4 hidden min-w-0 border-0 p-0 sm:block">
      <legend className="sr-only">Filter by status</legend>
      <div className="flex flex-wrap gap-2">
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

/** The open run, read from and written to `?run=`; the filters stay. */
function useRunParam(): [string | null, (runId: string | null) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const runId = params.get('run');
  const search = params.toString();
  const setRun = useCallback(
    (next: string | null) => {
      const copy = new URLSearchParams(search);
      if (next) copy.set('run', next);
      else copy.delete('run');
      router.replace(`${pathname}?${copy}`, { scroll: false });
    },
    [pathname, router, search],
  );
  return [runId, setRun];
}

/**
 * The Runs tab (C-285): every run of the project — worker slots, skills and
 * schedules — as a compact timeline by day, the former History. A run opens
 * in a sheet on a phone and in a panel beside the timeline from tablet up.
 */
export function RunsTab({ projectId }: { projectId: string }) {
  const url = useUrlFilters(RUN_FILTER_CODEC);
  const { filters, set } = url;
  const applied = useMemo(() => toRunQuery(filters), [filters]);
  const [openRun, setOpenRun] = useRunParam();
  const phone = useBreakpoint() === 'phone';
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

  const list = (
    <>
      <div className="mb-4">
        <RunFiltersBar url={url} />
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
          title: 'Runs could not be loaded',
          stillWorks: 'The feed, fleet and queue are still available.',
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
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
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
              {visible.length === 0 && !page.nextCursor ? (
                <EmptyState
                  title="Only abandoned runs so far"
                  description="Abandoned runs are hidden by default."
                />
              ) : (
                <Timeline
                  items={visible.map((run) => ({
                    id: run.id,
                    at: run.startedAt,
                    tone: RUN_STATUS_TONE[run.status],
                    title: (
                      <span
                        className={
                          run.id === openRun
                            ? 'font-semibold text-accent-ink'
                            : ''
                        }
                      >
                        {runTitle(run)}
                      </span>
                    ),
                    meta: runFacts(run),
                    onSelect: () => setOpenRun(run.id),
                    actions: (
                      <StatusPill
                        status={RUN_PILL_STATUS[run.status]}
                        label={RUN_STATUS_LABEL[run.status]}
                      />
                    ),
                  }))}
                  dayHeadingLevel={2}
                  hasMore={page.nextCursor !== null}
                  loadingMore={loadingMore}
                  onLoadMore={loadMore}
                  loadMoreLabel="Load older"
                />
              )}
            </>
          );
        }}
      </AsyncSection>
    </>
  );

  if (phone) {
    return (
      <>
        {list}
        <SheetRoot
          open={openRun !== null}
          onOpenChange={(open) => {
            if (!open) setOpenRun(null);
          }}
        >
          {openRun ? (
            <SheetContent side="bottom" title="Run" hideTitle>
              <RunDetailPane
                key={openRun}
                projectId={projectId}
                runId={openRun}
              />
            </SheetContent>
          ) : null}
        </SheetRoot>
      </>
    );
  }
  if (!openRun) return list;
  return (
    <ListDetail
      listLabel="Runs"
      listWidth="40%"
      list={list}
      detail={
        // The panel stays in view while the timeline beside it scrolls.
        <Card
          variant="content"
          pad="md"
          className="sm:sticky sm:top-4 sm:max-h-[calc(100dvh-2rem)] sm:overflow-y-auto"
        >
          <RunDetailPane
            key={openRun}
            projectId={projectId}
            runId={openRun}
            onClose={() => setOpenRun(null)}
          />
        </Card>
      }
    />
  );
}
