'use client';

import type {
  ProjectSummary,
  UsageBreakdownResponse,
  UsageBreakdownRow,
  UsageDimension,
  UsageSummaryResponse,
  UsageTimeseriesResponse,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { Chart } from '@andrewbehma/glass-ui/chart';
import {
  DataTable,
  type DataTableSort,
  sortRows,
} from '@andrewbehma/glass-ui/data-table';
import { DateInput } from '@andrewbehma/glass-ui/date-input';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Field, Select } from '@andrewbehma/glass-ui/field';
import { SectionUnavailable } from '@andrewbehma/glass-ui/section-unavailable';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@andrewbehma/glass-ui/segmented-control';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { Sparkline } from '@andrewbehma/glass-ui/sparkline';
import { StatTile } from '@andrewbehma/glass-ui/stat-tile';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { BudgetStrip } from '../../../components/budgets/budget-chip';
import { PageHeader } from '../../../components/page-header/page-header';
import { ScrollX } from '../../../components/scroll-x/scroll-x';
import { useCurrentUser } from '../../../components/shell/user-context';
import { ApiError, api } from '../../../lib/api';
import {
  BREAKDOWN_DIMENSIONS,
  browserZone,
  costChartSeries,
  costOrBlank,
  customRange,
  DIMENSION_LABEL,
  describeUsageError,
  formatAxisCost,
  formatCount,
  formatDay,
  formatTokens,
  formatUsd,
  groupLabel,
  intervalFor,
  MACHINE_WIDE_HINT,
  presetRange,
  RANGE_PRESETS,
  type RangePreset,
  rangeQuery,
  sparkValues,
  timeZones,
  type UsageRange,
} from '../../../lib/usage/format';

const PRESET_LABEL: Record<RangePreset, string> = {
  '24h': '24 h',
  '7d': '7 d',
  '30d': '30 d',
  custom: 'Custom',
};

function Segment({
  layoutId,
  active,
  onSelect,
  children,
}: {
  layoutId: string;
  active: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <SegmentedControlItem
      layoutId={layoutId}
      active={active}
      className="flex-none whitespace-nowrap"
    >
      <button
        type="button"
        aria-pressed={active}
        onClick={onSelect}
        className="relative min-h-(--size-tap) px-3 text-sm"
      >
        {children}
      </button>
    </SegmentedControlItem>
  );
}

interface Data {
  summary: UsageSummaryResponse;
  total: UsageTimeseriesResponse;
  byRuntime: UsageTimeseriesResponse;
  breakdown: UsageBreakdownResponse;
}

function Filters({
  preset,
  onPreset,
  fromDate,
  toDate,
  onDates,
  tz,
  onTz,
  projectId,
  onProject,
  projects,
}: {
  preset: RangePreset;
  onPreset: (preset: RangePreset) => void;
  fromDate: string;
  toDate: string;
  onDates: (from: string, to: string) => void;
  tz: string;
  onTz: (tz: string) => void;
  projectId: string;
  onProject: (id: string) => void;
  projects: ProjectSummary[];
}) {
  const zones = useMemo(() => timeZones(), []);
  return (
    <div className="flex flex-wrap items-end gap-3 [&>*]:min-w-0 [&>*:not(:first-child)]:flex-[1_1_12rem]">
      <Field label="Range">
        <SegmentedControl aria-label="Time range">
          {RANGE_PRESETS.map((p) => (
            <Segment
              key={p}
              layoutId="usage-range"
              active={preset === p}
              onSelect={() => onPreset(p)}
            >
              {PRESET_LABEL[p]}
            </Segment>
          ))}
        </SegmentedControl>
      </Field>
      <Field label="Project" htmlFor="usage-project">
        <Select
          id="usage-project"
          value={projectId}
          onChange={(e) => onProject(e.target.value)}
        >
          <option value="">All my projects</option>
          {projectId && !projects.some((p) => p.id === projectId) ? (
            <option value={projectId}>{projectId}</option>
          ) : null}
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.displayName}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Time zone" htmlFor="usage-tz">
        <Select id="usage-tz" value={tz} onChange={(e) => onTz(e.target.value)}>
          {zones.includes(tz) ? null : <option value={tz}>{tz}</option>}
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </Select>
      </Field>
      {preset === 'custom' ? (
        <>
          <Field label="From" htmlFor="usage-from">
            <DateInput
              id="usage-from"
              value={fromDate}
              max={toDate || undefined}
              onChange={(e) => onDates(e.target.value, toDate)}
            />
          </Field>
          <Field label="To (inclusive)" htmlFor="usage-to">
            <DateInput
              id="usage-to"
              value={toDate}
              min={fromDate || undefined}
              onChange={(e) => onDates(fromDate, e.target.value)}
            />
          </Field>
        </>
      ) : null}
    </div>
  );
}

/** Cost per bucket (zero-filled by the API), stacked by runtime. */
function CostChart({
  series,
  interval,
}: {
  series: UsageTimeseriesResponse;
  interval: 'hour' | 'day';
}) {
  const chartSeries = useMemo(() => costChartSeries(series), [series]);
  return (
    <Chart
      label={`Cost per ${interval}, stacked by runtime`}
      series={chartSeries}
      x="time"
      stacked
      height={220}
      yMin={0}
      formatX={(x) => formatDay(x, interval)}
      formatY={formatAxisCost}
      formatTooltip={({ x, entries }) => {
        const total = entries.reduce((sum, e) => sum + (e.y ?? 0), 0);
        return (
          <div className="flex min-w-40 flex-col gap-1 text-xs">
            <div className="font-medium">{formatDay(x, interval)}</div>
            {entries.map((entry) => (
              <div key={entry.series.id} className="flex justify-between gap-4">
                <span className="text-ink-2">{entry.series.name}</span>
                <span className="num">{formatUsd(String(entry.y ?? 0))}</span>
              </div>
            ))}
            {entries.length > 1 ? (
              <div className="flex justify-between gap-4 border-t border-line pt-1">
                <span>Total</span>
                <span className="num font-medium">
                  {formatUsd(String(total))}
                </span>
              </div>
            ) : null}
          </div>
        );
      }}
    />
  );
}

/** A tile's trend: clipped to the tile, and absent when it would be a flat line. */
function Trend({
  values,
  label,
  tone,
}: {
  values: number[];
  label: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'danger';
}) {
  const shown = sparkValues(values);
  if (!shown) return null;
  return (
    <div className="max-w-full overflow-hidden">
      <Sparkline values={shown} width={120} area tone={tone} label={label} />
    </div>
  );
}

/** R3: "no usage in this project" is not "no usage has ever been recorded". */
function UsageEmpty({
  projectId,
  isAdmin,
  onClearProject,
}: {
  projectId: string;
  isAdmin: boolean;
  onClearProject: () => void;
}) {
  if (projectId) {
    return (
      <EmptyState
        title="No usage for this project in this range"
        description="Try a longer range, or look at all your projects."
        action={
          <Button variant="glass" onClick={onClearProject}>
            Show all projects
          </Button>
        }
      />
    );
  }
  return (
    <EmptyState
      title="No usage in this range"
      description="Usage is recorded when an agent runs on a paired runner. Try a longer range, or connect a project and runner first."
      action={
        <Link
          href={isAdmin ? '/admin/runners' : '/projects'}
          className={buttonClassName({ variant: 'glass' })}
        >
          {isAdmin ? 'Open Runners' : 'Open Projects'}
        </Link>
      }
    />
  );
}

function BreakdownTable({
  dimension,
  rows,
  loading,
  empty,
}: {
  dimension: UsageDimension;
  rows: UsageBreakdownRow[];
  loading: boolean;
  empty: ReactNode;
}) {
  const router = useRouter();
  const [sort, setSort] = useState<DataTableSort | null>({
    columnId: 'cost',
    direction: 'desc',
  });

  const columns = useMemo(
    () => [
      {
        id: 'name',
        header: DIMENSION_LABEL[dimension],
        sortable: true,
        cell: (row: UsageBreakdownRow) => {
          const text = groupLabel(dimension, row.label, row.key);
          if (dimension === 'project' && !row.key) {
            return (
              <Tooltip content={MACHINE_WIDE_HINT}>
                <button
                  type="button"
                  className="cursor-help text-start underline decoration-dotted underline-offset-2"
                  onClick={(event) => event.stopPropagation()}
                >
                  {text}
                </button>
              </Tooltip>
            );
          }
          return text;
        },
      },
      {
        id: 'cost',
        header: 'Cost',
        sortable: true,
        align: 'end' as const,
        cell: (row: UsageBreakdownRow) => (
          <span className="num">
            {costOrBlank(row.costUsd, row.requests, row.unpricedRequests) ||
              '—'}
          </span>
        ),
      },
      {
        id: 'requests',
        header: 'Requests',
        sortable: true,
        align: 'end' as const,
        cell: (row: UsageBreakdownRow) => (
          <span className="num">{formatCount(row.requests)}</span>
        ),
      },
      {
        id: 'tokens',
        header: 'Tokens',
        sortable: true,
        align: 'end' as const,
        cell: (row: UsageBreakdownRow) => (
          <span className="num">{formatTokens(tokensOf(row))}</span>
        ),
      },
      {
        id: 'unpriced',
        header: 'Unpriced',
        sortable: true,
        align: 'end' as const,
        cell: (row: UsageBreakdownRow) =>
          row.unpricedRequests > 0 ? (
            <Badge tone="warn" label={formatCount(row.unpricedRequests)} />
          ) : (
            '—'
          ),
      },
    ],
    [dimension],
  );

  const sorted = useMemo(
    () =>
      sortRows(rows, columns, sort, (row, columnId) => {
        switch (columnId) {
          case 'name':
            return groupLabel(dimension, row.label, row.key);
          case 'cost':
            return row.unpricedRequests >= row.requests && row.requests > 0
              ? null
              : Number(row.costUsd);
          case 'requests':
            return row.requests;
          case 'tokens':
            return tokensOf(row);
          default:
            return row.unpricedRequests;
        }
      }),
    [rows, columns, sort, dimension],
  );

  // The empty state sits outside the scroll box: inside the table's minimum
  // width it would be cut off at 390 px.
  if (!loading && sorted.length === 0) return empty;

  return (
    <ScrollX label="Usage breakdown">
      <DataTable
        rows={sorted}
        getRowId={(row) => `${row.key ?? ''}|${row.projectId ?? ''}`}
        columns={columns}
        sort={sort}
        onSortChange={setSort}
        onRowActivate={(row) => {
          // A project row opens the project; a slot, issue or run row opens its project.
          const target = dimension === 'project' ? row.key : row.projectId;
          if (target) router.push(`/projects/${target}/fleet`);
        }}
        loading={loading}
        emptyState={empty}
        className="min-w-[36rem]"
      />
    </ScrollX>
  );
}

const tokensOf = (t: UsageBreakdownRow): number =>
  t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;

export default function UsagePage() {
  const user = useCurrentUser();
  const isAdmin = user.role === 'admin';
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState('');
  const [preset, setPreset] = useState<RangePreset>('7d');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [tz, setTz] = useState('UTC');
  const [dimension, setDimension] = useState<UsageDimension>('project');
  const [data, setData] = useState<Data>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [notFound, setNotFound] = useState(false);

  // The browser's zone is known only on the client; start on UTC for the server render.
  useEffect(() => setTz(browserZone()), []);

  // A link may carry the project (`/usage?projectId=…`); the filter keeps the URL in step.
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get(
      'projectId',
    );
    if (fromUrl) setProjectId(fromUrl);
  }, []);
  const chooseProject = (id: string) => {
    setProjectId(id);
    window.history.replaceState(
      null,
      '',
      id ? `/usage?projectId=${encodeURIComponent(id)}` : '/usage',
    );
  };

  useEffect(() => {
    api<ProjectSummary[]>('/projects')
      .then(setProjects)
      .catch(() => {
        // The project filter just stays on "all"; the page still works.
      });
  }, []);

  const range: UsageRange | null = useMemo(
    () =>
      preset === 'custom' ? customRange(fromDate, toDate) : presetRange(preset),
    [preset, fromDate, toDate],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` reloads on Try again
  useEffect(() => {
    if (!range) return;
    let cancelled = false;
    setData(undefined);
    setError(undefined);
    setNotFound(false);
    const interval = intervalFor(range);
    const get = <T,>(path: string, extra: Record<string, string>) =>
      api<T>(`${path}${rangeQuery(range, projectId, extra)}`);
    Promise.all([
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
      get<UsageBreakdownResponse>('/usage/breakdown', { dimension }),
    ])
      .then(([summary, total, byRuntime, breakdown]) => {
        if (!cancelled) setData({ summary, total, byRuntime, breakdown });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
        else {
          setError(describeUsageError(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [range, projectId, tz, dimension, attempt]);

  const interval = range ? intervalFor(range) : 'day';
  const totals = data?.summary.totals;
  const points = data?.total.series[0]?.points ?? [];
  const tokenTotal = totals
    ? totals.input +
      totals.output +
      totals.cacheRead +
      totals.cacheWrite5m +
      totals.cacheWrite1h
    : 0;
  const allUnpriced =
    totals !== undefined &&
    totals.requests > 0 &&
    totals.unpricedRequests >= totals.requests;

  return (
    <>
      <PageHeader
        title="Usage"
        description="API-equivalent cost — what these tokens would cost at public API prices. You run on subscriptions; this is not a bill."
      />

      <div className="mb-6">
        <Filters
          preset={preset}
          onPreset={setPreset}
          fromDate={fromDate}
          toDate={toDate}
          onDates={(from, to) => {
            setFromDate(from);
            setToDate(to);
          }}
          tz={tz}
          onTz={setTz}
          projectId={projectId}
          onProject={chooseProject}
          projects={projects}
        />
      </div>

      <BudgetStrip
        projects={
          projectId ? projects.filter((p) => p.id === projectId) : projects
        }
        userId={user.id}
      />

      {!range ? (
        <EmptyState
          title="Pick a range"
          description="Choose a first and a last day."
        />
      ) : notFound ? (
        <EmptyState
          title="Project not found"
          description="It does not exist, or you are not a member of it."
        />
      ) : error ? (
        <SectionUnavailable
          title="Usage is not answering"
          stillWorks={`${error} The filters above still work.`}
          action={
            <Button
              variant="glass"
              size="sm"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Try again
            </Button>
          }
        />
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label="API-equivalent cost"
              loading={!data}
              value={
                allUnpriced ? '—' : formatUsd(totals?.costUsd ?? '0') || '—'
              }
              hint={
                totals && totals.unpricedRequests > 0
                  ? 'Priced requests only'
                  : undefined
              }
            >
              <Trend
                values={points.map((p) => Number(p.costUsd))}
                label="Cost over the range"
              />
            </StatTile>
            <StatTile
              label="Requests"
              loading={!data}
              value={formatCount(totals?.requests ?? 0)}
            >
              <Trend
                values={points.map((p) => p.requests)}
                label="Requests over the range"
              />
            </StatTile>
            <StatTile
              label="Tokens"
              loading={!data}
              value={formatTokens(tokenTotal)}
              hint="Reasoning is inside output"
            >
              <Trend
                values={points.map((p) => p.tokens)}
                label="Tokens over the range"
              />
            </StatTile>
            <StatTile
              label="Unpriced requests"
              loading={!data}
              value={formatCount(totals?.unpricedRequests ?? 0)}
              hint={
                totals && totals.unpricedRequests > 0
                  ? isAdmin
                    ? 'No price matches the model, so not counted as $0. Fix it under Admin › Prices.'
                    : 'No price matches the model, so not counted as $0. An administrator fixes it under Admin › Prices.'
                  : 'Every request has a price'
              }
              href={
                isAdmin && totals && totals.unpricedRequests > 0
                  ? '/admin/prices'
                  : undefined
              }
            >
              <Trend
                values={points.map((p) => p.unpricedRequests)}
                tone="warn"
                label="Unpriced requests over the range"
              />
            </StatTile>
          </div>

          <section className="mb-6" aria-labelledby="usage-over-time">
            <h2 id="usage-over-time" className="mb-2 text-sm font-medium">
              Cost over time
            </h2>
            {data ? (
              data.byRuntime.series.length > 0 ? (
                <CostChart series={data.byRuntime} interval={interval} />
              ) : (
                <UsageEmpty
                  projectId={projectId}
                  isAdmin={isAdmin}
                  onClearProject={() => chooseProject('')}
                />
              )
            ) : (
              <Skeleton className="h-[220px] w-full" />
            )}
          </section>

          <section aria-labelledby="usage-breakdown">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
              <h2 id="usage-breakdown" className="text-sm font-medium">
                Breakdown
              </h2>
              {/* A flex item sizes to its content; the cap keeps the
                  segments scrolling inside the row at 390 px. */}
              <div className="min-w-0 max-w-full">
                <ScrollX>
                  <SegmentedControl aria-label="Breakdown by">
                    {BREAKDOWN_DIMENSIONS.map((d) => (
                      <Segment
                        key={d}
                        layoutId="usage-dimension"
                        active={dimension === d}
                        onSelect={() => setDimension(d)}
                      >
                        {DIMENSION_LABEL[d]}
                      </Segment>
                    ))}
                  </SegmentedControl>
                </ScrollX>
              </div>
            </div>
            {totals && totals.unpricedRequests > 0 ? (
              <p className="mb-2 text-xs text-ink-2">
                {formatCount(totals.unpricedRequests)} requests have no price,
                so their cost is left out.{' '}
                {isAdmin ? (
                  <>
                    Add the model under{' '}
                    <Link
                      href="/admin/prices"
                      className="text-ink underline underline-offset-2"
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
              dimension={dimension}
              rows={data?.breakdown.rows ?? []}
              loading={!data}
              empty={
                <UsageEmpty
                  projectId={projectId}
                  isAdmin={isAdmin}
                  onClearProject={() => chooseProject('')}
                />
              }
            />
          </section>
        </>
      )}
    </>
  );
}
