'use client';

import type {
  ProjectSummary,
  UsageBreakdownResponse,
  UsageBreakdownRow,
  UsageDimension,
  UsageSummaryResponse,
  UsageTimeseriesResponse,
} from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Banner } from 'glass-ui/banner';
import { DataTable, type DataTableSort, sortRows } from 'glass-ui/data-table';
import { DateInput } from 'glass-ui/date-input';
import { EmptyState } from 'glass-ui/empty-state';
import { Field, Select } from 'glass-ui/field';
import {
  SegmentedControl,
  SegmentedControlItem,
} from 'glass-ui/segmented-control';
import { Sparkline } from 'glass-ui/sparkline';
import { StatTile } from 'glass-ui/stat-tile';
import { toast } from 'glass-ui/toast';
import Link from 'next/link';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { BudgetStrip } from '../../../components/budgets/budget-chip';
import { useCurrentUser } from '../../../components/shell/user-context';
import { ApiError, api } from '../../../lib/api';
import {
  BREAKDOWN_DIMENSIONS,
  browserZone,
  costOrBlank,
  customRange,
  DIMENSION_LABEL,
  describeUsageError,
  formatCount,
  formatDay,
  formatTokens,
  formatUsd,
  groupLabel,
  intervalFor,
  presetRange,
  RANGE_PRESETS,
  type RangePreset,
  rangeQuery,
  timeZones,
  type UsageRange,
} from '../../../lib/usage/format';

const PRESET_LABEL: Record<RangePreset, string> = {
  '24h': '24 h',
  '7d': '7 d',
  '30d': '30 d',
  custom: 'Custom',
};

const RUNTIME_BAR: Record<string, string> = {
  claude: 'bg-ink',
  codex: 'bg-ink-3',
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
    <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">
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

/** Cost per bucket, stacked by runtime — plain bars until the chart primitives land (M3). */
function CostBars({
  series,
  interval,
}: {
  series: UsageTimeseriesResponse;
  interval: 'hour' | 'day';
}) {
  const labels = series.series[0]?.points.map((p) => p.t) ?? [];
  const stacks = labels.map((t, i) => {
    const parts = series.series.map((s) => ({
      runtime: s.key ?? 'unknown',
      cost: Number(s.points[i]?.costUsd ?? 0),
    }));
    return { t, parts, total: parts.reduce((sum, p) => sum + p.cost, 0) };
  });
  const max = Math.max(0, ...stacks.map((s) => s.total));
  return (
    <div>
      <div
        className="flex h-40 items-end gap-1"
        role="img"
        aria-label="Cost over time, stacked by runtime"
      >
        {stacks.map((stack) => (
          <div
            key={stack.t}
            className="flex h-full min-w-px flex-1 flex-col-reverse"
            title={`${formatDay(stack.t, interval)} · ${formatUsd(String(stack.total)) || '$0.00'}`}
          >
            {stack.parts.map((part) => (
              <div
                key={part.runtime}
                className={RUNTIME_BAR[part.runtime] ?? 'bg-ink-2'}
                style={{
                  height: max > 0 ? `${(part.cost / max) * 100}%` : '0%',
                }}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-3">
        <span>{labels[0] ? formatDay(labels[0], interval) : ''}</span>
        <span className="flex gap-3">
          {series.series.map((s) => (
            <span key={s.key ?? 'none'} className="flex items-center gap-1">
              <span
                className={`inline-block size-2 rounded-full ${RUNTIME_BAR[s.key ?? ''] ?? 'bg-ink-2'}`}
              />
              {s.label ?? s.key ?? 'unknown'}
            </span>
          ))}
        </span>
        <span>
          {labels.length > 0
            ? formatDay(labels[labels.length - 1] ?? '', interval)
            : ''}
        </span>
      </div>
    </div>
  );
}

function BreakdownTable({
  dimension,
  rows,
  loading,
}: {
  dimension: UsageDimension;
  rows: UsageBreakdownRow[];
  loading: boolean;
}) {
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
          return dimension === 'project' && row.key ? (
            <Link
              href={`/projects/${row.key}/fleet`}
              className="underline-offset-2 hover:underline"
            >
              {text}
            </Link>
          ) : (
            text
          );
        },
      },
      {
        id: 'cost',
        header: 'Cost',
        sortable: true,
        align: 'end' as const,
        cell: (row: UsageBreakdownRow) =>
          costOrBlank(row.costUsd, row.requests, row.unpricedRequests) || '—',
      },
      {
        id: 'requests',
        header: 'Requests',
        sortable: true,
        align: 'end' as const,
        cell: (row: UsageBreakdownRow) => formatCount(row.requests),
      },
      {
        id: 'tokens',
        header: 'Tokens',
        sortable: true,
        align: 'end' as const,
        cell: (row: UsageBreakdownRow) => formatTokens(tokensOf(row)),
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

  return (
    <DataTable
      rows={sorted}
      getRowId={(row) => `${row.key ?? ''}|${row.projectId ?? ''}`}
      columns={columns}
      sort={sort}
      onSortChange={setSort}
      loading={loading}
      emptyState={
        <EmptyState
          title="No usage"
          description="Nothing was recorded in this range."
        />
      }
    />
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
          toast.error(describeUsageError(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [range, projectId, tz, dimension]);

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
      <h1 className="mb-1 text-xl font-semibold">Usage</h1>
      <p className="mb-4 text-sm text-ink-3">
        API-equivalent cost — what these tokens would cost at public API prices.
        You run on subscriptions; this is not a bill.
      </p>

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
        <Banner tone="danger" title="Could not load usage">
          {error}
        </Banner>
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
              <Sparkline
                values={points.map((p) => Number(p.costUsd))}
                width={140}
                area
                label="Cost over the range"
              />
            </StatTile>
            <StatTile
              label="Requests"
              loading={!data}
              value={formatCount(totals?.requests ?? 0)}
            >
              <Sparkline
                values={points.map((p) => p.requests)}
                width={140}
                area
                label="Requests over the range"
              />
            </StatTile>
            <StatTile
              label="Tokens"
              loading={!data}
              value={formatTokens(tokenTotal)}
              hint="Reasoning is inside output"
            >
              <Sparkline
                values={points.map((p) => p.tokens)}
                width={140}
                area
                label="Tokens over the range"
              />
            </StatTile>
            <StatTile
              label="Unpriced requests"
              loading={!data}
              value={formatCount(totals?.unpricedRequests ?? 0)}
              hint={
                totals && totals.unpricedRequests > 0
                  ? 'No price matches the model — not counted as $0'
                  : 'Every request has a price'
              }
              href={
                isAdmin && totals && totals.unpricedRequests > 0
                  ? '/admin/prices'
                  : undefined
              }
            >
              <Sparkline
                values={points.map((p) => p.unpricedRequests)}
                width={140}
                tone={totals && totals.unpricedRequests > 0 ? 'warn' : 'ok'}
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
                <CostBars series={data.byRuntime} interval={interval} />
              ) : (
                <EmptyState
                  title="No usage"
                  description="Nothing was recorded in this range."
                />
              )
            ) : (
              <div className="h-40 animate-pulse rounded-surface bg-hover" />
            )}
          </section>

          <section aria-labelledby="usage-breakdown">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
              <h2 id="usage-breakdown" className="text-sm font-medium">
                Breakdown
              </h2>
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
            </div>
            <BreakdownTable
              dimension={dimension}
              rows={data?.breakdown.rows ?? []}
              loading={!data}
            />
          </section>
        </>
      )}
    </>
  );
}
