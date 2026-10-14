'use client';

import type { ProjectSummary, TaskPage } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import Link from 'next/link';
import { type ComponentProps, Suspense, useEffect, useState } from 'react';
import { PageHeader } from '../../../components/page-header/page-header';
import { AsyncSection } from '../../../components/prerequisites/async-section';
import { api } from '../../../lib/api';
import { useUrlFilters } from '../../../lib/filters/use-url-filters';
import { useErrorToast } from '../../../lib/section/use-error-toast';
import { useSection } from '../../../lib/section/use-section';
import {
  describePlannerError,
  hasTaskFilters,
  mergeTaskRows,
  plannerTarget,
  TASK_FILTER_CODEC,
  tasksQuery,
} from '../../../lib/tasks/format';
import { TasksFilters } from './tasks-filters';
import { TasksTable } from './tasks-table';

/** The empty state's action keeps client-side navigation. */
const NextLink: NonNullable<ComponentProps<typeof EmptyState>['link']> = ({
  href,
  className,
  children,
  ...rest
}) => (
  <Link href={href} className={className} {...rest}>
    {children}
  </Link>
);

/** Tasks span projects, so there is no single live topic to follow: poll. */
const POLL_MS = 15_000;

function usePoll(ms: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return tick;
}

function TasksView() {
  // The URL holds the filters: reload, back and a shared link all keep them.
  const url = useUrlFilters(TASK_FILTER_CODEC);
  const { filters, set } = url;
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const showError = useErrorToast();
  const tick = usePoll(POLL_MS);
  const query = tasksQuery(filters);

  // `tick` reloads the first page.
  const section = useSection(
    () => api<TaskPage>(`/tasks${query}`),
    [query, tick],
  );

  useEffect(() => {
    api<ProjectSummary[]>('/projects')
      .then((list) => {
        if (Array.isArray(list)) setProjects(list);
      })
      .catch(() => {
        // The project filter stays empty; the list still works.
      });
  }, []);

  const nextCursor = section.data?.nextCursor ?? null;
  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api<TaskPage>(
        `/tasks${tasksQuery(filters, nextCursor)}`,
      );
      section.setData((current) => ({
        items: mergeTaskRows(current?.items ?? [], page.items),
        nextCursor: page.nextCursor,
      }));
    } catch (err) {
      showError(describePlannerError(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const planner = plannerTarget(
    filters,
    projects.map((p) => p.id),
  );

  return (
    <>
      <PageHeader
        title="Tasks"
        description="Every task of the plans you can read, across your projects, from draft to merged."
      />

      <div className="mb-6">
        <TasksFilters url={url} projects={projects} />
      </div>

      <AsyncSection
        section={section}
        isEmpty={(page) => page.items.length === 0}
        unavailable={{
          title: 'Tasks are not answering',
          stillWorks: `${describePlannerError(section.error)} The filters above still work.`,
        }}
        skeleton={
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        }
        empty={
          hasTaskFilters(filters) ? (
            <EmptyState
              title="No tasks match these filters"
              description="Clear a filter to see more."
              action={{
                label: 'Clear filters',
                onClick: () =>
                  set({
                    projectId: '',
                    kind: '',
                    status: '',
                    planId: '',
                    q: '',
                  }),
              }}
            />
          ) : (
            <EmptyState
              title="No tasks yet"
              description="A task appears here when the planner splits a brief into tasks. Start with a brief in a project's Planner."
              link={NextLink}
              action={
                planner
                  ? {
                      label: 'Open Planner',
                      href: `/projects/${encodeURIComponent(planner)}/planner`,
                    }
                  : { label: 'Open Projects', href: '/projects' }
              }
            />
          )
        }
      >
        {(page) => (
          <>
            <TasksTable rows={page.items} />
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

export default function TasksPage() {
  // `useSearchParams` needs a boundary for the static shell.
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <TasksView />
    </Suspense>
  );
}
