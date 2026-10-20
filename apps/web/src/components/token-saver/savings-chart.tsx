'use client';

import { Chart } from '@andrewbehma/glass-ui/chart';
import type { TokenSaverSummary } from '@nautelle/shared';
import { useMemo } from 'react';
import { formatDate } from '../../lib/format';
import { formatSavedUsd } from '../../lib/token-saver/format';
import { savingsChartSeries } from '../../lib/token-saver/summary';
import { formatAxisCost } from '../../lib/usage/format';

/** Estimated dollars saved per UTC day (D13: "savings over time"). */
export function SavingsChart({ byDay }: { byDay: TokenSaverSummary['byDay'] }) {
  const series = useMemo(() => savingsChartSeries(byDay), [byDay]);
  return (
    <Chart
      label="Estimated savings per day"
      series={series}
      x="time"
      height={220}
      yMin={0}
      formatX={(x) => formatDate(x, 'day')}
      formatY={formatAxisCost}
      formatTooltip={({ x, entries }) => (
        <div className="flex min-w-36 flex-col gap-1 text-xs">
          <div className="font-medium">{formatDate(x, 'day')}</div>
          {entries.map((entry) => (
            <div key={entry.series.id} className="flex justify-between gap-4">
              <span className="text-ink-2">{entry.series.name}</span>
              <span className="num">{formatSavedUsd(entry.y ?? 0)}</span>
            </div>
          ))}
        </div>
      )}
    />
  );
}
