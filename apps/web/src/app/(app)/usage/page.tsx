'use client';

import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Section } from '@andrewbehma/glass-ui/section';
import { SegmentedControl } from '@andrewbehma/glass-ui/segmented-control';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import type {
  ProjectSummary,
  UsageBreakdownResponse,
  UsageSummaryResponse,
  UsageTimeseriesResponse,
} from '@nautelle/shared';
import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { BudgetStrip } from '../../../components/budgets/budget-chip';
import { PageHeader } from '../../../components/page-header/page-header';
import { AsyncSection } from '../../../components/prerequisites/async-section';
import { ScrollX } from '../../../components/scroll-x/scroll-x';
import { useCurrentUser } from '../../../components/shell/user-context';
import { ApiError, api } from '../../../lib/api';
import { useUrlFilters } from '../../../lib/filters/use-url-filters';
import { useSection } from '../../../lib/section/use-section';
import {
  breakdownDrill,
  USAGE_FILTER_CODEC,
  usageRange,
} from '../../../lib/usage/filters';
import {
  BREAKDOWN_DIMENSIONS,
  browserZone,
  DIMENSION_LABEL,
  describeUsageError,
  formatCount,
  intervalFor,
  rangeQuery,
} from '../../../lib/usage/format';
import { Segment } from '../workflows/segment';
import { BreakdownTable } from './breakdown-table';
import { SetBudget } from './set-budget';
import { TokenSaverSection } from './token-saver-section';
import { CostChart, UsageEmpty, UsageTiles } from './usage-figures';
import { UsageFilters } from './usage-filters';

interface Data {
  summary: UsageSummaryResponse;
  total: UsageTimeseriesResponse;
  byRuntime: UsageTimeseriesResponse;
  breakdown: UsageBreakdownResponse;
}

const isNotFound = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;

function UsageView() {
  const user = useCurrentUser();
  const isAdmin = user.role === 'admin';
  // The URL holds the range, project, zone and breakdown (#213).
  const url = useUrlFilters(USAGE_FILTER_CODEC);
  const { filters, set } = url;
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [budgetsSeen, setBudgetsSeen] = useState(0);

  // The browser's zone is known only on the client; start on UTC for the server render.
  const [ownZone, setOwnZone] = useState('UTC');
  useEffect(() => setOwnZone(browserZone()), []);
  const tz = filters.tz || ownZone;

  useEffect(() => {
    api<ProjectSummary[]>('/projects')
      .then((list) => {
        if (Array.isArray(list)) setProjects(list);
      })
      .catch(() => {
        // The project filter just stays on "all"; the page still works.
      });
  }, []);

  const range = useMemo(
    () => usageRange(filters),
    // A preset moves with the clock only on a new choice, as before.
    [filters],
  );
  const interval = range ? intervalFor(range) : 'day';
  const key = range
    ? rangeQuery(range, filters.projectId, { tz, by: filters.by })
    : '';

  const section = useSection<Data | null>(() => {
    if (!range) return Promise.resolve(null);
    const get = <T,>(path: string, extra: Record<string, string>) =>
      api<T>(`${path}${rangeQuery(range, filters.projectId, extra)}`);
    return Promise.all([
      get<UsageSummaryResponse>('/usage/summary', {}),
      get<UsageTimeseriesResponse>('/usage/timeseries', {
        interval,
        groupBy: 'none',
        tz,
      }),
      get<UsageTimeseriesResponse>('/usage/timeseries', {
        interval,
        groupBy: 'runtime',
        tz,
      }),
      get<UsageBreakdownResponse>('/usage/breakdown', {
        dimension: filters.by,
      }),
    ]).then(([summary, total, byRuntime, breakdown]) => ({
      summary,
      total,
      byRuntime,
      breakdown,
    }));
  }, [key]);

  // Token saver is per project: the narrowed one, else every project listed.
  const tokenSaverIds = useMemo(
    () => (filters.projectId ? [filters.projectId] : projects.map((p) => p.id)),
    [filters.projectId, projects],
  );

  const clearProject = () => set({ projectId: '' });
  const empty = (
    <UsageEmpty
      projectId={filters.projectId}
      isAdmin={isAdmin}
      onClearProject={clearProject}
    />
  );
  const drillable =
    filters.by === 'project' ||
    ((filters.by === 'slot' || filters.by === 'issue') && !filters.projectId);

  return (
    <>
      <PageHeader
        title="Usage"
        description="API-equivalent cost — what these tokens would cost at public API prices. You run on subscriptions; this is not a bill."
        actions={
          <SetBudget
            projectId={filters.projectId}
            projects={projects}
            isAdmin={isAdmin}
            onSaved={() => setBudgetsSeen((n) => n + 1)}
          />
        }
      />

      <div className="mb-6">
        <UsageFilters url={url} projects={projects} zone={tz} />
      </div>

      <BudgetStrip
        key={budgetsSeen}
        projects={
          filters.projectId
            ? projects.filter((p) => p.id === filters.projectId)
            : projects
        }
        userId={user.id}
      />

      {!range ? (
        <EmptyState
          title="Pick a range"
          description="Choose a first and a last day."
        />
      ) : isNotFound(section.error) ? (
        <EmptyState
          title="Project not found"
          description="It does not exist, or you are not a member of it."
          action={{ label: 'Show all projects', onClick: clearProject }}
        />
      ) : (
        <AsyncSection
          section={section}
          isEmpty={() => false}
          unavailable={{
            title: 'Usage is not answering',
            stillWorks: `${describeUsageError(section.error)} The filters above still work.`,
          }}
          empty={empty}
          skeleton={
            <div className="flex flex-col gap-6" aria-busy="true">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {[0, 1, 2, 3].map((n) => (
                  <Skeleton key={n} className="h-28 w-full" />
                ))}
              </div>
              <Skeleton className="h-[220px] w-full" />
            </div>
          }
        >
          {(data) =>
            data ? (
              <div
                aria-busy={section.loading}
                className={`transition-opacity ${section.loading ? 'opacity-60' : ''}`}
              >
                <UsageTiles
                  summary={data.summary}
                  total={data.total}
                  isAdmin={isAdmin}
                />

                <Section className="mb-6" title="Cost over time" surface="none">
                  {data.byRuntime.series.length > 0 ? (
                    <CostChart series={data.byRuntime} interval={interval} />
                  ) : (
                    empty
                  )}
                </Section>

                <Section
                  title="Breakdown"
                  surface="none"
                  description={
                    drillable
                      ? 'Open a row to narrow the page to it.'
                      : undefined
                  }
                >
                  {/* Under the heading, not beside it: at 390 px the
                      segments would squeeze the heading to a word a line. */}
                  <div className="mb-3 min-w-0 max-w-full">
                    <ScrollX>
                      <SegmentedControl size="sm" aria-label="Breakdown by">
                        {BREAKDOWN_DIMENSIONS.map((d) => (
                          <Segment
                            key={d}
                            layoutId="usage-dimension"
                            size="sm"
                            active={filters.by === d}
                            onSelect={() => set({ by: d })}
                          >
                            {DIMENSION_LABEL[d]}
                          </Segment>
                        ))}
                      </SegmentedControl>
                    </ScrollX>
                  </div>
                  {data.summary.totals.unpricedRequests > 0 ? (
                    <p className="mb-2 text-xs text-ink-2">
                      {formatCount(data.summary.totals.unpricedRequests)}{' '}
                      requests have no price, so their cost is left out.{' '}
                      {isAdmin ? (
                        <>
                          Add the model under{' '}
                          <Link
                            href="/admin/prices"
                            className="text-accent-ink underline underline-offset-2"
                          >
                            Admin › Prices
                          </Link>
                          .
                        </>
                      ) : (
                        'An administrator adds the model under Admin › Prices.'
                      )}
                    </p>
                  ) : null}
                  <BreakdownTable
                    dimension={filters.by}
                    rows={data.breakdown.rows}
                    loading={false}
                    empty={empty}
                    onDrill={
                      drillable
                        ? (row) => {
                            const next = breakdownDrill(
                              filters.by,
                              row,
                              filters,
                            );
                            if (next) set(next);
                          }
                        : undefined
                    }
                  />
                </Section>
              </div>
            ) : null
          }
        </AsyncSection>
      )}

      {range && tokenSaverIds.length > 0 ? (
        <TokenSaverSection
          projectIds={tokenSaverIds}
          singleProjectId={filters.projectId}
          range={range}
        />
      ) : null}
    </>
  );
}

export default function UsagePage() {
  // `useSearchParams` needs a boundary for the static shell.
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <UsageView />
    </Suspense>
  );
}
