'use client';

import type { ProjectSummary, TaskPage } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { SectionUnavailable } from '@andrewbehma/glass-ui/section-unavailable';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { PageHeader } from '../../../components/page-header/page-header';
import { api } from '../../../lib/api';
import { useErrorToast } from '../../../lib/section/use-error-toast';
import {
  describePlannerError,
  EMPTY_TASK_FILTERS,
  filtersFromSearch,
  filtersSearch,
  hasTaskFilters,
  mergeTaskRows,
  type TaskFilters,
  tasksQuery,
} from '../../../lib/tasks/format';
import { TasksFilters } from './tasks-filters';
import { TasksTable } from './tasks-table';

/** Tasks span projects, so there is no single live topic to follow: poll. */
const POLL_MS = 15_000;

function TasksView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  // The URL holds the filters: reload, back and a shared link all keep them.
  const filters = useMemo(
    () => filtersFromSearch(new URLSearchParams(params.toString())),
    [params],
  );
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [rows, setRows] = useState<TaskPage['items']>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // A failed load is never "no tasks": keep what is on screen and say so.
  const [failure, setFailure] = useState<unknown>(null);
  const showError = useErrorToast();
  // Only the newest request may write: a slow older one must not overwrite.
  const generation = useRef(0);

  const loadFirst = useCallback(async (applied: TaskFilters) => {
    const mine = ++generation.current;
    try {
      const page = await api<TaskPage>(`/tasks${tasksQuery(applied)}`);
      if (mine !== generation.current) return;
      setRows(page.items);
      setNextCursor(page.nextCursor);
      setFailure(null);
    } catch (err) {
      if (mine !== generation.current) return;
      setFailure(err);
    }
  }, []);

  useEffect(() => {
    setRows(undefined);
    setFailure(null);
    void loadFirst(filters);
    const timer = setInterval(() => void loadFirst(filters), POLL_MS);
    return () => clearInterval(timer);
  }, [filters, loadFirst]);

  useEffect(() => {
    api<ProjectSummary[]>('/projects')
      .then((list) => {
        if (Array.isArray(list)) setProjects(list);
      })
      .catch(() => {
        // The project filter stays empty; the list still works.
      });
  }, []);

  const apply = (next: TaskFilters) =>
    router.replace(`${pathname}${filtersSearch(next)}`, { scroll: false });

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api<TaskPage>(
        `/tasks${tasksQuery(filters, nextCursor)}`,
      );
      setRows((current) => mergeTaskRows(current ?? [], page.items));
      setNextCursor(page.nextCursor);
    } catch (err) {
      showError(describePlannerError(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const unavailable =
    failure !== null ? (
      <SectionUnavailable
        title="Tasks are not answering"
        stillWorks={`${describePlannerError(failure)} The filters above still work.`}
        action={
          <Button
            variant="glass"
            size="sm"
            onClick={() => void loadFirst(filters)}
          >
            Try again
          </Button>
        }
      />
    ) : null;

  return (
    <>
      <PageHeader
        title="Tasks"
        description="Every task of the plans you can read, across your projects, from draft to merged."
      />

      <div className="mb-6">
        <TasksFilters
          filters={filters}
          projects={projects}
          onChange={(patch) => apply({ ...filters, ...patch })}
          onReset={() => apply(EMPTY_TASK_FILTERS)}
        />
      </div>

      {rows === undefined ? (
        (unavailable ?? (
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ))
      ) : rows.length === 0 ? (
        <>
          {unavailable}
          {hasTaskFilters(filters) ? (
            <EmptyState
              title="No tasks match these filters"
              description="Clear a filter to see more."
              action={
                <Button
                  variant="glass"
                  onClick={() => apply(EMPTY_TASK_FILTERS)}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No tasks yet"
              description="A task appears here when the planner splits a brief into tasks. Start with a brief in a project's Planner."
              action={
                <Link
                  href="/projects"
                  className="text-sm text-accent-ink underline"
                >
                  Open Projects
                </Link>
              }
            />
          )}
        </>
      ) : (
        <>
          {unavailable}
          <TasksTable rows={rows} />
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

export default function TasksPage() {
  // `useSearchParams` needs a boundary for the static shell.
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <TasksView />
    </Suspense>
  );
}
