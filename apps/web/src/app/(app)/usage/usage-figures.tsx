'use client';

import { Chart } from '@andrewbehma/glass-ui/chart';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Sparkline } from '@andrewbehma/glass-ui/sparkline';
import { StatTile } from '@andrewbehma/glass-ui/stat-tile';
import type {
  UsageSummaryResponse,
  UsageTimeseriesResponse,
} from '@nautelle/shared';
import Link from 'next/link';
import { type ComponentProps, useMemo } from 'react';
import {
  costChartSeries,
  formatAxisCost,
  formatCount,
  formatDay,
  formatTokens,
  formatUsd,
  sparkValues,
} from '../../../lib/usage/format';

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

/** Cost per bucket (zero-filled by the API), stacked by runtime. */
export function CostChart({
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

/** The four figures of the range, each with its trend. */
export function UsageTiles({
  summary,
  total,
  isAdmin,
}: {
  summary: UsageSummaryResponse;
  total: UsageTimeseriesResponse;
  isAdmin: boolean;
}) {
  const totals = summary.totals;
  const points = total.series[0]?.points ?? [];
  const tokenTotal =
    totals.input +
    totals.output +
    totals.cacheRead +
    totals.cacheWrite5m +
    totals.cacheWrite1h;
  const allUnpriced =
    totals.requests > 0 && totals.unpricedRequests >= totals.requests;
  return (
    <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {/* One hue per figure, the same as on Overview for cost (#163). */}
      <StatTile
        hue={4}
        label="API-equivalent cost"
        value={allUnpriced ? '—' : formatUsd(totals.costUsd) || '—'}
        hint={totals.unpricedRequests > 0 ? 'Priced requests only' : undefined}
      >
        <Trend
          values={points.map((p) => Number(p.costUsd))}
          label="Cost over the range"
        />
      </StatTile>
      <StatTile hue={1} label="Requests" value={formatCount(totals.requests)}>
        <Trend
          values={points.map((p) => p.requests)}
          label="Requests over the range"
        />
      </StatTile>
      <StatTile
        hue={7}
        label="Tokens"
        value={formatTokens(tokenTotal)}
        hint="Reasoning is inside output"
      >
        <Trend
          values={points.map((p) => p.tokens)}
          label="Tokens over the range"
        />
      </StatTile>
      <StatTile
        hue={5}
        label="Unpriced requests"
        value={formatCount(totals.unpricedRequests)}
        hint={
          totals.unpricedRequests > 0
            ? isAdmin
              ? 'No price matches the model, so not counted as $0. Fix it under Admin › Prices.'
              : 'No price matches the model, so not counted as $0. An administrator fixes it under Admin › Prices.'
            : 'Every request has a price'
        }
        href={
          isAdmin && totals.unpricedRequests > 0 ? '/admin/prices' : undefined
        }
      >
        <Trend
          values={points.map((p) => p.unpricedRequests)}
          tone="warn"
          label="Unpriced requests over the range"
        />
      </StatTile>
    </div>
  );
}

/** R3: "no usage in this project" is not "no usage has ever been recorded". */
export function UsageEmpty({
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
        action={{ label: 'Show all projects', onClick: onClearProject }}
      />
    );
  }
  return (
    <EmptyState
      title="No usage in this range"
      description="Usage is recorded when an agent runs on a paired runner. Try a longer range, or connect a project and runner first."
      link={NextLink}
      action={
        isAdmin
          ? { label: 'Open Runners', href: '/admin/runners' }
          : { label: 'Open Projects', href: '/projects' }
      }
    />
  );
}
