'use client';

import {
  type ProjectSummary,
  projectRoleAtLeast,
  type WorkPage,
  workCardHref,
} from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ComponentProps, Suspense, useEffect, useState } from 'react';
import { NewCardDialog } from '../../../components/board/new-card-dialog';
import { AsyncSection } from '../../../components/prerequisites/async-section';
import { WorkFilters } from '../../../components/work/work-filters';
import { WorkHeader } from '../../../components/work/work-header';
import { WorkTable } from '../../../components/work/work-table';
import { api } from '../../../lib/api';
import { useUrlFilters } from '../../../lib/filters/use-url-filters';
import { useErrorToast } from '../../../lib/section/use-error-toast';
import { useSection } from '../../../lib/section/use-section';
import { describePlannerError } from '../../../lib/tasks/format';
import {
  hasWorkFilters,
  mergeWorkItems,
  WORK_FILTER_CODEC,
  workQuery,
} from '../../../lib/work/format';

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

/** Work spans projects, so there is no single live topic to follow: poll. */
const POLL_MS = 15_000;

function usePoll(ms: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return tick;
}

function WorkView() {
  // The URL holds the filters: reload, back and a shared link all keep them.
  const url = useUrlFilters(WORK_FILTER_CODEC);
  const { filters, set } = url;
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pickProject, setPickProject] = useState(false);
  const [newCardOpen, setNewCardOpen] = useState(false);
  const showError = useErrorToast();
  const tick = usePoll(POLL_MS);
  const query = workQuery(filters);

  // `tick` reloads the first page.
  const section = useSection(
    () => api<WorkPage>(`/work${query}`),
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
      const page = await api<WorkPage>(
        `/work${workQuery(filters, nextCursor)}`,
      );
      section.setData((current) => ({
        items: mergeWorkItems(current?.items ?? [], page.items),
        nextCursor: page.nextCursor,
      }));
    } catch (err) {
      showError(describePlannerError(err));
    } finally {
      setLoadingMore(false);
    }
  };

  // The project New work and the empty state's Planner link point to: the
  // filtered one, else the only one.
  const target =
    projects.find((p) => p.id === filters.projectId) ??
    (projects.length === 1 ? projects[0] : undefined);
  const canCreate = target
    ? projectRoleAtLeast(target.role, 'operator')
    : false;

  const openBoard = () => {
    if (filters.projectId) {
      router.push(`/projects/${encodeURIComponent(filters.projectId)}/board`);
    } else {
      setPickProject(true);
    }
  };

  return (
    <>
      <WorkHeader
        view="list"
        eyebrow="Workspace"
        description="Cards, plan tasks and suggestions across every project."
        onSelectList={() => {}}
        onSelectBoard={openBoard}
      >
        {canCreate ? (
          <Button onClick={() => setNewCardOpen(true)}>
            <Plus aria-hidden="true" className="size-4" />
            New work
          </Button>
        ) : null}
      </WorkHeader>

      {pickProject && !filters.projectId ? (
        <p className="mb-3 text-sm text-ink-3" role="status">
          The Board shows one project. Pick a project in the filter below.
        </p>
      ) : null}

      <div className="mb-6">
        <WorkFilters url={url} projects={projects} />
      </div>

      <AsyncSection
        section={section}
        isEmpty={(page) => page.items.length === 0}
        unavailable={{
          title: 'Work is not answering',
          stillWorks: `${describePlannerError(section.error)} The filters above still work.`,
        }}
        skeleton={
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        }
        empty={
          hasWorkFilters(filters) ? (
            <EmptyState
              title="Nothing matches these filters"
              description="Clear a filter to see more."
              action={{
                label: 'Clear filters',
                onClick: () =>
                  set({
                    projectId: '',
                    source: '',
                    kind: '',
                    status: '',
                    planId: '',
                    q: '',
                  }),
              }}
            />
          ) : (
            <EmptyState
              title="No work yet"
              description="Add a card on a project's Board, or start a brief in its Planner — both show up here."
              link={NextLink}
              action={
                target
                  ? {
                      label: 'Open Planner',
                      href: `/projects/${encodeURIComponent(target.id)}/planner`,
                    }
                  : { label: 'Open Projects', href: '/projects' }
              }
            />
          )
        }
      >
        {(page) => (
          <>
            <WorkTable rows={page.items} />
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

      {target && canCreate ? (
        <NewCardDialog
          projectId={target.id}
          open={newCardOpen}
          settings={undefined}
          onOpenChange={setNewCardOpen}
          onCreated={(number) => router.push(workCardHref(target.id, number))}
        />
      ) : null}
    </>
  );
}

export default function WorkRoute() {
  // `useSearchParams` needs a boundary for the static shell.
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <WorkView />
    </Suspense>
  );
}
