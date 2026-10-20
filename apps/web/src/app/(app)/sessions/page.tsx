'use client';

import type {
  ProjectSummary,
  SessionListResponse,
  SessionSummary,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { DataTable } from '@andrewbehma/glass-ui/data-table';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Section } from '@andrewbehma/glass-ui/section';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../../../components/page-header/page-header';
import { AsyncSection } from '../../../components/prerequisites/async-section';
import { ScrollX } from '../../../components/scroll-x/scroll-x';
import {
  LiveStatePill,
  OriginBadge,
} from '../../../components/sessions/origin-badge';
import { useCurrentUser } from '../../../components/shell/user-context';
import { api } from '../../../lib/api';
import { useUrlFilters } from '../../../lib/filters/use-url-filters';
import { formatNumber } from '../../../lib/format';
import { Time } from '../../../lib/format/time';
import { useLive } from '../../../lib/live/use-live';
import { useErrorToast } from '../../../lib/section/use-error-toast';
import { useSection } from '../../../lib/section/use-section';
import {
  RUNTIME_LABEL,
  SESSION_FILTER_CODEC,
} from '../../../lib/sessions/filters';
import {
  cacheTokens,
  describeSessionError,
  describeSessionHint,
  formatCost,
  formatDuration,
  formatTokens,
  hasSessionFilters,
  liveTopicFor,
  queryString,
  sessionName,
  toQuery,
} from '../../../lib/sessions/format';
import { SessionsFilters } from './sessions-filters';

const PAGE_SIZE = 50;
/** Without a project filter there is no single topic to follow, so poll (like /projects). */
const POLL_MS = 15_000;

const figure = (text: string) => <span className="num">{text}</span>;

function useColumns() {
  return useMemo(
    () => [
      {
        id: 'session',
        header: 'Session',
        cell: (s: SessionSummary) => (
          <span className="flex min-w-0 items-center gap-2">
            <Link
              href={`/sessions/${s.id}`}
              className="max-w-[15rem] truncate font-medium underline-offset-2 hover:underline"
              // The row opens the session too; one activation, not two.
              onClick={(event) => event.stopPropagation()}
              tabIndex={-1}
            >
              {sessionName(s)}
            </Link>
            {s.parsed ? null : (
              <Tooltip content="The runner reported this session, but its transcript has not been read yet. Turns, tokens and cost may be missing.">
                <span className="shrink-0 cursor-help">
                  <Badge tone="warn" label="Not yet read" />
                </span>
              </Tooltip>
            )}
          </span>
        ),
      },
      {
        id: 'origin',
        header: 'Origin',
        width: '6.5rem',
        cell: (s: SessionSummary) => (
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <OriginBadge session={s} />
            <LiveStatePill session={s} />
          </span>
        ),
      },
      {
        id: 'started',
        header: 'Started',
        width: '5.5rem',
        cell: (s: SessionSummary) => <Time value={s.startedAt} />,
      },
      {
        id: 'project',
        header: 'Project',
        cell: (s: SessionSummary) => (
          <span className="block max-w-[9rem] truncate">
            {s.projectName ?? <span className="text-ink-3">No project</span>}
            {s.slotName ? (
              <span className="text-ink-3"> · {s.slotName}</span>
            ) : null}
          </span>
        ),
      },
      {
        id: 'runtime',
        header: 'Runtime',
        cell: (s: SessionSummary) => (
          <span className="flex max-w-[8rem] min-w-0 flex-col">
            <span className="truncate">
              {RUNTIME_LABEL[s.runtime] ?? s.runtime}
            </span>
            {s.models.length > 0 ? (
              <span className="truncate text-xs text-ink-3">
                {s.models.join(', ')}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: 'turns',
        header: (
          <Tooltip content="Turns / requests">
            <span className="cursor-help">Turns</span>
          </Tooltip>
        ),
        align: 'end' as const,
        width: '5.5rem',
        cell: (s: SessionSummary) =>
          figure(
            `${formatNumber(s.turns)} / ${formatNumber(s.totals.requests)}`,
          ),
      },
      {
        id: 'tokens',
        header: (
          <Tooltip content="Input / output / cache tokens">
            <span className="cursor-help">Tokens</span>
          </Tooltip>
        ),
        align: 'end' as const,
        width: '10rem',
        cell: (s: SessionSummary) =>
          figure(
            `${formatTokens(s.totals.input)} / ${formatTokens(s.totals.output)} / ${formatTokens(cacheTokens(s.totals))}`,
          ),
      },
      {
        id: 'cost',
        header: 'Cost',
        align: 'end' as const,
        width: '4.5rem',
        cell: (s: SessionSummary) => figure(formatCost(s.totals.costUsd)),
      },
      {
        id: 'duration',
        header: 'Duration',
        align: 'end' as const,
        width: '6rem',
        cell: (s: SessionSummary) => figure(formatDuration(s.durationMs)),
      },
    ],
    [],
  );
}

function SessionsView() {
  const user = useCurrentUser();
  const isAdmin = user.role === 'admin';
  const router = useRouter();
  const columns = useColumns();
  // The URL holds the filters: reload, back and a shared link all keep them.
  const url = useUrlFilters(SESSION_FILTER_CODEC);
  const { filters, set } = url;
  const applied = useMemo(() => toQuery(filters), [filters]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const showError = useErrorToast();

  const section = useSection(async () => {
    return api<SessionListResponse>(
      `/sessions${queryString(applied, { limit: PAGE_SIZE })}`,
    );
  }, [applied]);

  useEffect(() => {
    api<ProjectSummary[]>('/projects')
      .then((list) => {
        if (Array.isArray(list)) setProjects(list);
      })
      .catch(() => {
        // The project filter stays empty; the list still works.
      });
  }, []);

  const topic = liveTopicFor(applied);
  useLive(topic, (message) => {
    if (message.event === 'sessions.changed') section.retry();
  });

  // No topic to follow → poll the first page, like /projects does.
  const { retry } = section;
  useEffect(() => {
    if (topic) return;
    const timer = setInterval(retry, POLL_MS);
    return () => clearInterval(timer);
  }, [topic, retry]);

  const nextCursor = section.data?.nextCursor ?? null;
  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api<SessionListResponse>(
        `/sessions${queryString(applied, { cursor: nextCursor, limit: PAGE_SIZE })}`,
      );
      section.setData((current) => ({
        items: [...(current?.items ?? []), ...page.items],
        nextCursor: page.nextCursor,
      }));
    } catch (err) {
      showError(describeSessionHint(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const clear = () =>
    set({
      projectId: '',
      runtime: '',
      origin: '',
      fromDate: '',
      toDate: '',
      model: '',
      slot: '',
      unassigned: false,
    });

  return (
    <>
      <PageHeader
        title="Sessions"
        description="Every agent session your runners have reported, with its tokens and cost."
      />

      <div className="mb-6">
        <SessionsFilters url={url} projects={projects} isAdmin={isAdmin} />
      </div>

      <Section title="All sessions" surface="none">
        <AsyncSection
          section={section}
          isEmpty={(page) => page.items.length === 0}
          unavailable={{
            title: 'Sessions are not answering',
            stillWorks: `${describeSessionError(section.error)} The filters above still work.`,
          }}
          skeleton={
            <div className="flex flex-col gap-3" aria-busy="true">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          }
          empty={
            hasSessionFilters(applied) ? (
              <EmptyState
                title="No sessions match these filters"
                description="Widen the date range or clear a filter to see more."
                action={{ label: 'Clear filters', onClick: clear }}
              />
            ) : (
              <EmptyState
                title="No sessions yet"
                description="A session appears here when an agent runs on a paired runner and reports its transcript."
                link={NextLink}
                action={{
                  label: isAdmin ? 'Open Runners' : 'Open Projects',
                  href: isAdmin ? '/admin/runners' : '/projects',
                }}
              />
            )
          }
        >
          {(page) => (
            <>
              <ScrollX label="Sessions">
                <DataTable
                  rows={page.items}
                  getRowId={(s) => s.id}
                  columns={columns}
                  onRowActivate={(s) => router.push(`/sessions/${s.id}`)}
                  stickyHeader={false}
                  className="min-w-[62rem]"
                />
              </ScrollX>
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
      </Section>
    </>
  );
}

/** The empty state's action keeps client-side navigation. */
const NextLink: NonNullable<
  React.ComponentProps<typeof EmptyState>['link']
> = ({ href, className, children, ...rest }) => (
  <Link href={href} className={className} {...rest}>
    {children}
  </Link>
);

export default function SessionsPage() {
  // `useSearchParams` needs a boundary for the static shell.
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <SessionsView />
    </Suspense>
  );
}
