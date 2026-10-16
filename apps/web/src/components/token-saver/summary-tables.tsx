'use client';

import type {
  TokenSaverBeforeAfter,
  TokenSaverFilterSavings,
  TokenSaverSummary,
} from '@agentdock/shared';
import { DataTable } from '@andrewbehma/glass-ui/data-table';
import type { ReactNode } from 'react';
import { formatCost, formatNumber } from '../../lib/format';
import {
  filterLabel,
  formatRate,
  formatSavedUsd,
  passThroughShare,
  runKindLabel,
} from '../../lib/token-saver/format';
import { costChange } from '../../lib/token-saver/summary';
import { ScrollX } from '../scroll-x/scroll-x';

const num = (text: string) => <span className="num">{text || '—'}</span>;

/** Filters with what each saved; the dashboard adds the pass-through columns. */
export function FilterTable({
  filters,
  empty,
  label,
  passThrough = false,
}: {
  filters: readonly TokenSaverFilterSavings[];
  empty: ReactNode;
  label: string;
  /** Show how many commands were run raw and how many came back unchanged. */
  passThrough?: boolean;
}) {
  if (filters.length === 0) return empty;
  const columns = [
    {
      id: 'filter',
      header: 'Filter',
      cell: (f: TokenSaverFilterSavings) => filterLabel(f.filter),
    },
    {
      id: 'saved',
      header: 'Saved ≈',
      align: 'end' as const,
      cell: (f: TokenSaverFilterSavings) => num(formatSavedUsd(f.estimateUsd)),
    },
    {
      id: 'commands',
      header: 'Commands',
      align: 'end' as const,
      cell: (f: TokenSaverFilterSavings) => num(formatNumber(f.commands, 0)),
    },
    ...(passThrough
      ? [
          {
            id: 'bypassed',
            header: 'Run raw',
            align: 'end' as const,
            cell: (f: TokenSaverFilterSavings) =>
              num(formatNumber(f.bypassed, 0)),
          },
          {
            id: 'original',
            header: 'Returned the original',
            align: 'end' as const,
            cell: (f: TokenSaverFilterSavings) =>
              num(
                `${formatNumber(f.passedThrough, 0)} · ${formatRate(passThroughShare(f))}`,
              ),
          },
        ]
      : []),
  ];
  return (
    <ScrollX label={label}>
      <DataTable
        rows={[...filters]}
        getRowId={(f) => f.filter}
        columns={columns}
        className="min-w-[30rem]"
      />
    </ScrollX>
  );
}

/** What a run of a kind cost on average without and with Token saver (D12). */
export function BeforeAfterTable({
  rows,
  empty,
}: {
  rows: readonly TokenSaverBeforeAfter[];
  empty: ReactNode;
}) {
  const shown = rows.filter((r) => r.beforeRuns > 0 || r.afterRuns > 0);
  if (shown.length === 0) return empty;
  const side = (avg: string | null, runs: number) =>
    avg === null
      ? num('')
      : num(`${formatCost(avg)} · ${formatNumber(runs, 0)} runs`);
  const columns = [
    {
      id: 'kind',
      header: 'Run kind',
      cell: (r: TokenSaverBeforeAfter) => runKindLabel(r.runKind),
    },
    {
      id: 'before',
      header: 'Before (avg per run)',
      align: 'end' as const,
      cell: (r: TokenSaverBeforeAfter) => side(r.beforeAvgUsd, r.beforeRuns),
    },
    {
      id: 'after',
      header: 'After (avg per run)',
      align: 'end' as const,
      cell: (r: TokenSaverBeforeAfter) => side(r.afterAvgUsd, r.afterRuns),
    },
    {
      id: 'change',
      header: 'Change',
      align: 'end' as const,
      cell: (r: TokenSaverBeforeAfter) => {
        const change = costChange(r);
        if (change === null) return num('');
        const percent = formatRate(Math.abs(change));
        return num(change === 0 ? '0%' : `${change < 0 ? '−' : '+'}${percent}`);
      },
    },
  ];
  return (
    <ScrollX label="Cost per run, before and after Token saver">
      <DataTable
        rows={shown}
        getRowId={(r) => r.runKind}
        columns={columns}
        className="min-w-[32rem]"
      />
    </ScrollX>
  );
}

/** Savings split by the launch that ran the command (D1's eight kinds). */
export function RunKindTable({
  rows,
  empty,
}: {
  rows: TokenSaverSummary['byRunKind'];
  empty: ReactNode;
}) {
  if (rows.length === 0) return empty;
  const columns = [
    {
      id: 'kind',
      header: 'Run kind',
      cell: (r: TokenSaverSummary['byRunKind'][number]) =>
        runKindLabel(r.runKind),
    },
    {
      id: 'saved',
      header: 'Saved ≈',
      align: 'end' as const,
      cell: (r: TokenSaverSummary['byRunKind'][number]) =>
        num(formatSavedUsd(r.estimateUsd)),
    },
    {
      id: 'commands',
      header: 'Commands',
      align: 'end' as const,
      cell: (r: TokenSaverSummary['byRunKind'][number]) =>
        num(formatNumber(r.commands, 0)),
    },
  ];
  return (
    <ScrollX label="Savings by run kind">
      <DataTable
        rows={[...rows]}
        getRowId={(r) => r.runKind}
        columns={columns}
        className="min-w-[24rem]"
      />
    </ScrollX>
  );
}
