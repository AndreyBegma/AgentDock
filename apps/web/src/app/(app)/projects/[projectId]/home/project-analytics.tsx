'use client';

import type {
  ApprovalsView,
  BudgetView,
  QueueView,
  RunPage,
  UsageSummaryResponse,
  UsageTimeseriesResponse,
} from '@agentdock/shared';
import { Card } from '@andrewbehma/glass-ui/card';
import { Chart, type ChartSeries } from '@andrewbehma/glass-ui/chart';
import { KeyValueList } from '@andrewbehma/glass-ui/key-value-list';
import { Progress } from '@andrewbehma/glass-ui/progress';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { Sparkline } from '@andrewbehma/glass-ui/sparkline';
import { StatTile } from '@andrewbehma/glass-ui/stat-tile';
import {
  formatCost,
  formatNumber,
  formatTokens,
} from '../../../../../lib/format';
import { RUN_KIND_LABEL } from '../../../../../lib/history/format';
import { waitingApprovals } from '../../../../../lib/overview/dashboard';
import {
  costTrend,
  isMerged,
  leadTimes,
  leadTimeTrend,
  median,
  PERIOD_LABEL,
  type PeriodRanges,
  type ProjectPeriod,
  percentDelta,
  shortDuration,
  successRate,
  throughput,
  timeByKind,
} from '../../../../../lib/project-home/analytics';
import type { Section } from '../../../../../lib/section/use-section';
import { sparkValues } from '../../../../../lib/usage/format';

export interface ProjectFigures {
  runs: Section<RunPage>;
  previousRuns: Section<RunPage>;
  cost: Section<UsageSummaryResponse>;
  previousCost: Section<UsageSummaryResponse>;
  costSeries: Section<UsageTimeseriesResponse>;
  budgets: Section<BudgetView[]>;
  queue: Section<QueueView>;
  approvals: Section<ApprovalsView>;
}

const SPARK = { width: 72, height: 28 } as const;

/** A tile's trend, or nothing when it would be a flat line pretending. */
function Trend({ values, label }: { values: number[]; label: string }) {
  const trend = sparkValues(values);
  return trend ? <Sparkline values={trend} {...SPARK} label={label} /> : null;
}

const notAnswering = (what: string) => `${what} is not answering`;

/** The four figures of the period, each with where it is explained. */
export function ProjectStats({
  projectId,
  period,
  ranges,
  figures,
}: {
  projectId: string;
  period: ProjectPeriod;
  ranges: PeriodRanges;
  figures: ProjectFigures;
}) {
  const { runs, previousRuns, cost, previousCost, costSeries, budgets } =
    figures;
  const history = `/projects/${projectId}/history`;
  const runsLoading = runs.loading && !runs.data;
  const runsFailed = runs.data === undefined && runs.error !== null;
  // A page is 200 runs; a longer period counts what it holds and says so.
  const more = runs.data?.nextCursor ? '+' : '';

  const items = runs.data?.items ?? [];
  const merged = items.filter(isMerged).length;
  const previousMerged = previousRuns.data?.counts.succeeded;
  const lead = median(leadTimes(items));
  const rate = runs.data ? successRate(runs.data.counts) : null;
  const finished = runs.data
    ? runs.data.counts.succeeded + runs.data.counts.failed
    : 0;

  const spent = cost.data ? Number(cost.data.totals.costUsd) : null;
  const previousSpent = previousCost.data
    ? Number(previousCost.data.totals.costUsd)
    : null;
  const budget = budgets.data?.find((b) => b.enabled && b.current !== null);
  const costDelta =
    spent !== null ? percentDelta(spent, previousSpent, false) : undefined;

  const throughputData = runs.data
    ? throughput(items, ranges.current, ranges.bucketMs)
    : null;
  const vsPrevious = `vs previous ${period}`;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {/* Hues echo the Overview's tiles: merged green, cost amber. */}
      <StatTile
        hue={3}
        label="Merged pull requests"
        loading={runsLoading}
        value={
          runsFailed ? '—' : <span className="num">{`${merged}${more}`}</span>
        }
        {...(previousMerged !== undefined && runs.data
          ? (() => {
              const delta = percentDelta(merged, previousMerged, true);
              return delta
                ? { delta: { ...delta, value: `${delta.value} ${vsPrevious}` } }
                : {};
            })()
          : {})}
        hint={
          runsFailed ? notAnswering('History') : `Runs ${PERIOD_LABEL[period]}`
        }
        href={`${history}?status=succeeded`}
      >
        {throughputData ? (
          <Trend
            values={throughputData.merged}
            label={`Merged pull requests, ${PERIOD_LABEL[period]}`}
          />
        ) : null}
      </StatTile>
      <StatTile
        hue={1}
        label="Median lead time"
        loading={runsLoading}
        value={
          runsFailed ? '—' : <span className="num">{shortDuration(lead)}</span>
        }
        hint={
          runsFailed
            ? notAnswering('History')
            : lead === null
              ? 'Nothing merged yet'
              : 'From a run’s start to its merge'
        }
        href={`${history}?status=succeeded`}
      >
        {runs.data ? (
          <Trend
            values={leadTimeTrend(items, ranges.current, ranges.bucketMs)}
            label={`Median lead time, ${PERIOD_LABEL[period]}`}
          />
        ) : null}
      </StatTile>
      <StatTile
        hue={4}
        label="Cost"
        loading={cost.loading && !cost.data}
        value={
          spent === null ? (
            '—'
          ) : (
            <span className="num">{formatCost(spent)}</span>
          )
        }
        {...(costDelta
          ? {
              delta: {
                ...costDelta,
                value: `${costDelta.value} ${vsPrevious}`,
              },
            }
          : {})}
        hint={
          spent === null
            ? notAnswering('Usage')
            : budget?.current
              ? `${formatNumber(budget.current.percent, 0)}% of the ${budget.period} budget`
              : 'API-equivalent'
        }
        href={`/usage?projectId=${encodeURIComponent(projectId)}&range=${period}`}
      >
        {costSeries.data ? (
          <Trend
            values={costTrend(costSeries.data)}
            label={`Cost, ${PERIOD_LABEL[period]}`}
          />
        ) : null}
      </StatTile>
      <StatTile
        label="Success rate"
        loading={runsLoading}
        value={
          runsFailed || rate === null ? (
            '—'
          ) : (
            <span className="num">{`${Math.round(rate * 100)}%`}</span>
          )
        }
        hint={
          runsFailed
            ? notAnswering('History')
            : finished === 0
              ? 'No run has finished yet'
              : `${formatNumber(runs.data?.counts.failed ?? 0)} failed of ${formatNumber(finished)} finished`
        }
        href={`${history}?status=failed`}
      />
    </div>
  );
}

/** Runs that finished per bucket, merged against failed. */
export function ThroughputCard({
  period,
  ranges,
  runs,
}: {
  period: ProjectPeriod;
  ranges: PeriodRanges;
  runs: Section<RunPage>;
}) {
  const data = runs.data
    ? throughput(runs.data.items, ranges.current, ranges.bucketMs)
    : null;
  const series: ChartSeries[] = data
    ? [
        {
          id: 'merged',
          name: 'Merged',
          kind: 'bar',
          color: 'series-1',
          points: data.starts.map((t, i) => ({
            x: new Date(t),
            y: data.merged[i] ?? 0,
          })),
        },
        {
          id: 'failed',
          name: 'Failed',
          kind: 'bar',
          color: 'danger',
          points: data.starts.map((t, i) => ({
            x: new Date(t),
            y: data.failed[i] ?? 0,
          })),
        },
      ]
    : [];
  return (
    <Card pad="md" className="flex min-w-0 flex-col gap-3">
      <SectionHeader
        title="Throughput"
        description={`Runs that finished per ${period === '24h' ? 'hour' : 'day'}, ${PERIOD_LABEL[period]}.`}
      />
      {data ? (
        <Chart
          label="Merged and failed runs"
          x="time"
          series={series}
          height={184}
          yMin={0}
          formatY={(y) => formatNumber(y, 0)}
        />
      ) : runs.error !== null ? (
        <p className="py-8 text-center text-sm text-ink-3">
          {notAnswering('History')}.
        </p>
      ) : (
        <Skeleton className="h-46 w-full" />
      )}
    </Card>
  );
}

/** Where the agents' time went, and what waits in line. */
export function WorkBreakdownCard({
  period,
  figures,
}: {
  period: ProjectPeriod;
  figures: Pick<ProjectFigures, 'runs' | 'queue' | 'approvals' | 'cost'>;
}) {
  const { runs, queue, approvals, cost } = figures;
  const shares = runs.data ? timeByKind(runs.data.items) : null;
  const totals = cost.data?.totals;
  return (
    <Card pad="md" className="flex min-w-0 flex-col gap-3">
      <SectionHeader
        title="Where the work went"
        description={`Share of agent time by kind of run, ${PERIOD_LABEL[period]}.`}
      />
      {shares === null ? (
        runs.error !== null ? (
          <p className="text-sm text-ink-3">{notAnswering('History')}.</p>
        ) : (
          <Skeleton className="h-24 w-full" />
        )
      ) : shares.length === 0 ? (
        <p className="text-sm text-ink-3">No agent time in this period.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {shares.slice(0, 5).map((share) => (
            <li key={share.kind}>
              <Progress
                value={Math.round(share.share * 100)}
                max={100}
                label={RUN_KIND_LABEL[share.kind]}
                hint={`${Math.round(share.share * 100)}% · ${shortDuration(share.ms)}`}
              />
            </li>
          ))}
        </ul>
      )}
      <div className="mt-auto border-t border-line pt-3">
        <KeyValueList
          dense
          items={[
            {
              key: 'queue',
              label: 'Queue',
              value: (
                <span className="num">
                  {queue.data
                    ? `${formatNumber(queue.data.items.length)} ready`
                    : '—'}
                  {approvals.data
                    ? ` · ${formatNumber(waitingApprovals([approvals.data]))} waiting approval`
                    : ''}
                </span>
              ),
            },
            {
              key: 'tokens',
              label: 'Tokens',
              value: (
                <span className="num">
                  {totals
                    ? `${formatTokens(totals.input + totals.cacheRead + totals.cacheWrite5m + totals.cacheWrite1h)} in / ${formatTokens(totals.output)} out`
                    : '—'}
                </span>
              ),
            },
          ]}
        />
      </div>
    </Card>
  );
}
