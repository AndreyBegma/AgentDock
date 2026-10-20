'use client';

import {
  TOKEN_SAVER_UNMEASURED_KINDS,
  type TokenSaverCostPerRound,
} from '@nautelle/shared';
import type { ReactNode } from 'react';
import { formatCost, formatNumber, formatTokens } from '../../lib/format';
import {
  formatChange,
  formatRate,
  SESSION_KIND_LABEL,
  UNMEASURED_KIND_LABEL,
} from '../../lib/token-saver/format';
import {
  type CostPerRoundTrend,
  costPerRoundTrends,
} from '../../lib/token-saver/summary';
import { ResponsiveRows } from '../responsive-rows/responsive-rows';

const num = (text: string) => <span className="num">{text || '—'}</span>;

/** `2026-10-12` → `Week of Oct 12`. */
const weekLabel = (week: string): string =>
  `Week of ${new Date(`${week}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })}`;

/**
 * The measured columns every cost-per-round table shares. Seven or eight
 * columns do not fit a tablet's content column, so these tables are stacked
 * rows below desktop (C-301).
 */
const measured = <T,>(of: (row: T) => TokenSaverCostPerRound) => [
  {
    id: 'rounds',
    header: 'Rounds',
    align: 'end' as const,
    cell: (r: T) => num(formatNumber(of(r).rounds, 0)),
  },
  {
    id: 'median',
    header: 'Median cost',
    align: 'end' as const,
    cell: (r: T) => num(formatCost(of(r).medianUsd)),
  },
  {
    id: 'p90',
    header: 'p90 cost',
    align: 'end' as const,
    cell: (r: T) => num(formatCost(of(r).p90Usd)),
  },
  {
    id: 'share',
    header: 'Cache read share',
    align: 'end' as const,
    cell: (r: T) => num(formatRate(of(r).cacheReadShare)),
  },
  {
    id: 'peak',
    header: 'Peak context',
    align: 'end' as const,
    cell: (r: T) => num(formatTokens(of(r).medianPeakContext)),
  },
  {
    id: 'turns',
    header: 'Turns',
    align: 'end' as const,
    cell: (r: T) => num(formatNumber(of(r).medianTurns, 1)),
  },
];

/**
 * #663 D5: the lead of the Token saver page — per session kind, its newest
 * week's cost per round and how the median moved since the oldest week in
 * the range (the before/after of a release that landed in between).
 */
export function CostPerRoundTable({
  rows,
  empty,
}: {
  rows: readonly TokenSaverCostPerRound[];
  empty: ReactNode;
}) {
  const trends = costPerRoundTrends(rows);
  if (trends.length === 0) return empty;
  const columns = [
    {
      id: 'kind',
      header: 'Session kind',
      cell: (t: CostPerRoundTrend) => (
        <span className="flex flex-col">
          <span>{SESSION_KIND_LABEL[t.sessionKind]}</span>
          <span className="text-ink-3 text-xs">{weekLabel(t.latest.week)}</span>
        </span>
      ),
    },
    ...measured((t: CostPerRoundTrend) => t.latest),
    {
      id: 'change',
      header: 'Median since first week',
      align: 'end' as const,
      cell: (t: CostPerRoundTrend) => num(formatChange(t.change)),
    },
  ];
  return (
    <ResponsiveRows
      label="Cost per round by session kind"
      stackBelow="desktop"
      rows={trends}
      getRowId={(t) => t.sessionKind}
      columns={columns}
    />
  );
}

/** #663 D5: every session kind's cost per round, week by week. */
export function CostPerRoundWeeksTable({
  rows,
}: {
  rows: readonly TokenSaverCostPerRound[];
}) {
  if (rows.length === 0) return null;
  const columns = [
    {
      id: 'kind',
      header: 'Session kind',
      cell: (r: TokenSaverCostPerRound) => SESSION_KIND_LABEL[r.sessionKind],
    },
    {
      id: 'week',
      header: 'Week',
      cell: (r: TokenSaverCostPerRound) => weekLabel(r.week),
    },
    ...measured((r: TokenSaverCostPerRound) => r),
  ];
  return (
    <ResponsiveRows
      label="Cost per round by week"
      stackBelow="desktop"
      rows={[...rows]}
      getRowId={(r) => `${r.sessionKind}:${r.week}`}
      columns={columns}
    />
  );
}

/** #663: the launches cost per round leaves out, said once. */
export function UnmeasuredKindsNote() {
  const names = TOKEN_SAVER_UNMEASURED_KINDS.map(
    (k) => UNMEASURED_KIND_LABEL[k],
  );
  return (
    <p className="text-ink-3 text-sm">
      {`Not measured yet: ${names.join(', ')} — they do not record the session their requests ran in, so their cost cannot be tied to a round. Codex sessions report no requests.`}
    </p>
  );
}
