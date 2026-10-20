'use client';

import {
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
} from '@andrewbehma/glass-ui/popover';
import { StatTile } from '@andrewbehma/glass-ui/stat-tile';
import type { WorkflowsSummaryResponse } from '@nautelle/shared';
import { Info } from 'lucide-react';
import { formatNumber, pluralize } from '../../../lib/format';
import {
  formatAverage,
  formatAverageDuration,
  formatFlow,
  formatRate,
  TILE_HINT,
  TILE_SUMMARY,
} from '../../../lib/workflows/format';

type Metric = keyof typeof TILE_HINT;

/**
 * A tile's hint: one line, and an ⓘ that opens the definition. A popover,
 * not a tooltip, so a tap on a phone opens it too.
 */
function Hint({
  metric,
  label,
  lead,
  detail,
}: {
  metric: Metric;
  label: string;
  /** Facts in front of the summary: "412 times". */
  lead?: string;
  /** The figures behind the value, under the definition. */
  detail?: string;
}) {
  return (
    <span className="flex items-start gap-1">
      <span>
        {lead ? `${lead} · ` : ''}
        {TILE_SUMMARY[metric]}
      </span>
      <PopoverRoot>
        <PopoverTrigger
          aria-label={`What ${label} means`}
          className="-my-0.5 grid size-5 flex-none place-items-center rounded-full text-ink-3 hover:bg-hover hover:text-ink"
        >
          <Info aria-hidden="true" className="size-3.5" />
        </PopoverTrigger>
        <PopoverContent title={label} className="max-w-72">
          <p className="text-sm text-ink-2">{TILE_HINT[metric]}</p>
          {detail ? <p className="num mt-2 text-sm">{detail}</p> : null}
        </PopoverContent>
      </PopoverRoot>
    </span>
  );
}

/** The six figures, each with its definition behind an ⓘ. */
export function WorkflowTiles({
  summary,
}: {
  summary: WorkflowsSummaryResponse | undefined;
}) {
  const loading = !summary;
  const flow = summary?.topToolFlow ?? null;
  return (
    <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <StatTile
        hue={1}
        label="Avg agent depth"
        loading={loading}
        value={
          <span className="num">
            {formatAverage(summary?.avgDepth ?? null)}
          </span>
        }
        hint={<Hint metric="depth" label="Avg agent depth" />}
      />
      <StatTile
        hue={2}
        label="Avg subagents"
        loading={loading}
        value={
          <span className="num">
            {formatAverage(summary?.avgSubagents ?? null)}
          </span>
        }
        hint={<Hint metric="subagents" label="Avg subagents" />}
      />
      <StatTile
        hue={3}
        label="Success rate"
        loading={loading}
        value={
          <span className="num">
            {formatRate(summary?.successRate ?? null)}
          </span>
        }
        hint={
          <Hint
            metric="successRate"
            label="Success rate"
            detail={
              summary && summary.ended > 0
                ? `${formatNumber(summary.outcomes.completed)} completed of ${formatNumber(summary.ended)} ended; ${formatNumber(summary.outcomes.error)} error, ${formatNumber(summary.outcomes.abandoned)} abandoned.`
                : undefined
            }
          />
        }
      />
      <StatTile
        hue={7}
        label="Top tool flow"
        loading={loading}
        value={
          <span
            className="block truncate font-mono text-[0.85em]"
            title={formatFlow(flow)}
          >
            {formatFlow(flow)}
          </span>
        }
        hint={
          <Hint
            metric="topToolFlow"
            label="Top tool flow"
            lead={flow ? pluralize(flow.count, 'time') : undefined}
          />
        }
      />
      <StatTile
        hue={5}
        label="Avg compactions"
        loading={loading}
        value={
          <span className="num">
            {formatAverage(summary?.avgCompactions ?? null)}
          </span>
        }
        hint={<Hint metric="compactions" label="Avg compactions" />}
      />
      <StatTile
        hue={8}
        label="Avg duration"
        loading={loading}
        value={
          <span className="num">
            {formatAverageDuration(summary?.avgDurationMs ?? null)}
          </span>
        }
        hint={<Hint metric="duration" label="Avg duration" />}
      />
    </div>
  );
}
