'use client';

import type {
  ActivityItem,
  ActivityPage,
  ActivityQuery,
  ProjectSummary,
} from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { SectionUnavailable } from '@andrewbehma/glass-ui/section-unavailable';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { Timeline } from '@andrewbehma/glass-ui/timeline';
import Link from 'next/link';
import {
  type ComponentProps,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ACTIVITY_FILTER_CODEC,
  EMPTY_ACTIVITY_FILTERS,
  groupRows,
  hasActivityFilters,
  isNotFound,
  matchesQuery,
  mergeItems,
  PAGE_SIZE,
  POLL_MS,
  PROJECT_ACTIVITY_FILTER_CODEC,
  planLive,
  queryString,
  SCROLLED_PX,
  toActivityQuery,
} from '../../../lib/activity/format';
import { api, describeError, describeErrorHint } from '../../../lib/api';
import { useUrlFilters } from '../../../lib/filters/use-url-filters';
import { useErrorToast } from '../../../lib/section/use-error-toast';
import { type Names, TopicListener, toEntries } from './feed-entries';
import { FeedToolbar } from './feed-toolbar';

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

type FeedProps = {
  projectId?: string;
  isAdmin: boolean;
};

/**
 * The activity feed (spec 21 UI): a filter toolbar whose state is the URL, a
 * day-grouped timeline with runs about one slot or PR folded, load more, and
 * live insertion. `projectId` fixes it to one project; without it the feed is
 * the caller's whole feed, with a project filter.
 */
export function ActivityFeed(props: FeedProps) {
  return (
    <Suspense fallback={<FeedSkeleton />}>
      <Feed {...props} />
    </Suspense>
  );
}

function FeedSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

function Feed({ projectId, isAdmin }: FeedProps) {
  const fixed = projectId !== undefined;
  const url = useUrlFilters(
    fixed ? PROJECT_ACTIVITY_FILTER_CODEC : ACTIVITY_FILTER_CODEC,
  );
  const form = url.filters;
  const applied = useMemo(() => toActivityQuery(form), [form]);

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [items, setItems] = useState<ActivityItem[]>();
  const [pending, setPending] = useState<ActivityItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [missing, setMissing] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // A failed load is never "no activity": keep what is on screen and say so.
  const [failure, setFailure] = useState<unknown>(null);
  const showError = useErrorToast();
  const generation = useRef(0);
  const topRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<ActivityItem[] | undefined>(undefined);
  const pendingRef = useRef<ActivityItem[]>([]);
  itemsRef.current = items;
  pendingRef.current = pending;

  const appliedRef = useRef(applied);
  appliedRef.current = applied;

  const base = fixed ? `/projects/${projectId}/activity` : '/activity';
  const reset = () => url.replace(EMPTY_ACTIVITY_FILTERS);

  /** Reads refs only, so it is stable and never sees stale filters. */
  const receive = useCallback((incoming: ActivityItem[]) => {
    const current = itemsRef.current;
    if (!current) return;
    const known = new Set([
      ...current.map((i) => i.id),
      ...pendingRef.current.map((i) => i.id),
    ]);
    const fresh = incoming.filter(
      (item) => !known.has(item.id) && matchesQuery(item, appliedRef.current),
    );
    if (fresh.length === 0) return;
    // Scrolled away from the top? New items wait behind the "N new" pill.
    const top = topRef.current?.getBoundingClientRect().top ?? 0;
    if (top < -SCROLLED_PX) setPending((p) => mergeItems(p, fresh));
    else setItems((c) => mergeItems(c ?? [], fresh));
  }, []);

  const loadFirst = useCallback(
    async (query: ActivityQuery, reset: boolean) => {
      const mine = ++generation.current;
      try {
        const page = await api<ActivityPage>(
          `${base}${queryString(query, { limit: PAGE_SIZE })}`,
        );
        if (mine !== generation.current) return;
        setMissing(false);
        setFailure(null);
        if (reset) {
          setItems(page.items);
          setPending([]);
          setNextCursor(page.nextCursor);
        } else {
          receive(page.items);
        }
      } catch (err) {
        if (mine !== generation.current) return;
        if (isNotFound(err)) setMissing(true);
        else setFailure(err);
      }
    },
    [base, receive],
  );

  const showNew = () => {
    setItems((c) => mergeItems(c ?? [], pending));
    setPending([]);
    topRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  useEffect(() => {
    setItems(undefined);
    setFailure(null);
    loadFirst(applied, true);
  }, [applied, loadFirst]);

  // The project filter, and the runners' names for actors.
  useEffect(() => {
    api<ProjectSummary[]>('/projects')
      .then((list) => {
        if (Array.isArray(list)) setProjects(list);
      })
      .catch(() => {
        // The project filter stays empty and runners read "runner"; the feed still works.
      });
  }, []);

  const plan = useMemo(
    () =>
      planLive({
        projectId: projectId ?? applied.projectId,
        projectIds: projects.map((p) => p.id),
        isAdmin,
      }),
    [projectId, applied.projectId, projects, isAdmin],
  );

  useEffect(() => {
    if (!plan.poll) return;
    const timer = setInterval(() => loadFirst(applied, false), POLL_MS);
    return () => clearInterval(timer);
  }, [plan.poll, applied, loadFirst]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api<ActivityPage>(
        `${base}${queryString(applied, { cursor: nextCursor, limit: PAGE_SIZE })}`,
      );
      setItems((current) => mergeItems(current ?? [], page.items));
      setNextCursor(page.nextCursor);
    } catch (err) {
      showError(describeErrorHint(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const names = useMemo<Names>(
    () => ({
      projects: new Map(projects.map((p) => [p.id, p.displayName])),
      runners: new Map(projects.map((p) => [p.runnerId, p.runnerName])),
    }),
    [projects],
  );
  const actors = useMemo(() => {
    const seen = new Map<string, string>();
    for (const item of items ?? []) {
      if (item.actorType === 'user' && item.actorId && item.actorEmail) {
        seen.set(item.actorId, item.actorEmail);
      }
    }
    for (const [id, name] of names.runners) seen.set(id, `${name} (runner)`);
    return seen;
  }, [items, names]);

  const toggle = useCallback((id: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const entries = useMemo(
    () => toEntries(groupRows(items ?? []), open, toggle, names, fixed),
    [items, open, toggle, names, fixed],
  );

  if (missing) {
    return (
      <EmptyState
        title="Project not found"
        description="It does not exist, or you are not a member of it."
      />
    );
  }

  return (
    <>
      {plan.topics.map((topic) => (
        <TopicListener key={topic} topic={topic} onItem={(i) => receive([i])} />
      ))}

      <div className="mb-4">
        <FeedToolbar
          url={url}
          projects={projects}
          showProject={!fixed}
          actors={actors}
        />
      </div>

      <div ref={topRef} />
      {failure !== null ? (
        <div className="mb-4">
          <SectionUnavailable
            title="Activity is not answering"
            stillWorks={`${describeError(failure)} The filters above still work.`}
            action={
              <Button
                variant="glass"
                size="sm"
                onClick={() => loadFirst(applied, items === undefined)}
              >
                Try again
              </Button>
            }
          />
        </div>
      ) : null}
      {items === undefined ? (
        failure !== null ? null : (
          <FeedSkeleton />
        )
      ) : (
        <Timeline
          items={entries}
          hasMore={nextCursor !== null}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
          newCount={pending.length}
          onShowNew={showNew}
          dayHeadingLevel={2}
          className="[&_li]:rounded-none [&_li]:bg-transparent [&_ol]:divide-y [&_ol]:divide-line"
          empty={
            hasActivityFilters(applied) ? (
              <EmptyState
                title="No activity matches these filters"
                description="Widen the date range or clear a filter to see more."
                action={{ label: 'Clear filters', onClick: reset }}
              />
            ) : (
              <EmptyState
                title="No activity yet"
                description="Events appear here as the orchestrator opens pull requests, hits blockers and finishes work."
                link={NextLink}
                action={
                  fixed
                    ? {
                        label: 'Open Fleet',
                        href: `/projects/${projectId}/fleet`,
                      }
                    : isAdmin
                      ? { label: 'Open Runners', href: '/admin/runners' }
                      : { label: 'Open Projects', href: '/projects' }
                }
              />
            )
          }
        />
      )}
    </>
  );
}
