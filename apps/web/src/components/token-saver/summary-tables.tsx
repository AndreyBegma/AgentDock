'use client';

import type {
  TokenSaverBeforeAfter,
  TokenSaverFilterSavings,
  TokenSaverPromptCache,
  TokenSaverSummary,
  TokenSaverUnfilteredProgram,
} from '@agentdock/shared';
import { DataTable } from '@andrewbehma/glass-ui/data-table';
import type { ReactNode } from 'react';
import { formatCost, formatNumber, formatTokens } from '../../lib/format';
import {
  cacheReadShare,
  filterLabel,
  formatChange,
  formatRate,
  formatSavedUsd,
  inputTokensPerRun,
  passThroughShare,
  runKindLabel,
  UNFILTERED_HINT,
} from '../../lib/token-saver/format';
import { costChange, unfilteredReasons } from '../../lib/token-saver/summary';
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
      cell: (r: TokenSaverBeforeAfter) => num(formatChange(costChange(r))),
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

type ReasonRow = ReturnType<typeof unfilteredReasons>[number];

/** #648: "No filter" split by reason — compound, uncovered, mode and the legacy `none`. */
export function UnfilteredReasonTable({
  filters,
}: {
  filters: readonly TokenSaverFilterSavings[];
}) {
  const columns = [
    {
      id: 'reason',
      header: 'Reason',
      cell: (r: ReasonRow) => (
        <span className="flex flex-col">
          <span>{filterLabel(r.filter)}</span>
          <span className="text-ink-3 text-xs">
            {UNFILTERED_HINT[r.filter]}
          </span>
        </span>
      ),
    },
    {
      id: 'commands',
      header: 'Commands',
      align: 'end' as const,
      cell: (r: ReasonRow) => num(formatNumber(r.commands, 0)),
    },
    {
      id: 'share',
      header: 'Share of unfiltered',
      align: 'end' as const,
      cell: (r: ReasonRow) => num(formatRate(r.share)),
    },
  ];
  return (
    <ScrollX label="Why commands went unfiltered">
      <DataTable
        rows={unfilteredReasons(filters)}
        getRowId={(r) => r.filter}
        columns={columns}
        className="min-w-[30rem]"
      />
    </ScrollX>
  );
}

/** #648: the programs no filter ran on, most commands first. */
export function UnfilteredProgramTable({
  programs,
  empty,
}: {
  programs: readonly TokenSaverUnfilteredProgram[];
  empty: ReactNode;
}) {
  if (programs.length === 0) return empty;
  const columns = [
    {
      id: 'program',
      header: 'Program',
      cell: (p: TokenSaverUnfilteredProgram) => (
        <code className="font-mono text-xs">{p.program}</code>
      ),
    },
    {
      id: 'commands',
      header: 'Commands',
      align: 'end' as const,
      cell: (p: TokenSaverUnfilteredProgram) =>
        num(formatNumber(p.commands, 0)),
    },
  ];
  return (
    <ScrollX label="Most frequent unfiltered programs">
      <DataTable
        rows={[...programs]}
        getRowId={(p) => p.program}
        columns={columns}
        className="min-w-[20rem]"
      />
    </ScrollX>
  );
}

/** #648: the measured prompt cache of each run kind, from usage. */
export function PromptCacheTable({
  rows,
  empty,
}: {
  rows: readonly TokenSaverPromptCache[];
  empty: ReactNode;
}) {
  if (rows.length === 0) return empty;
  const columns = [
    {
      id: 'kind',
      header: 'Run kind',
      cell: (r: TokenSaverPromptCache) => runKindLabel(r.runKind),
    },
    {
      id: 'runs',
      header: 'Runs',
      align: 'end' as const,
      cell: (r: TokenSaverPromptCache) => num(formatNumber(r.runs, 0)),
    },
    {
      id: 'share',
      header: 'Cache read share',
      align: 'end' as const,
      cell: (r: TokenSaverPromptCache) => num(formatRate(cacheReadShare(r))),
    },
    {
      id: 'perRun',
      header: 'Input tokens per run',
      align: 'end' as const,
      cell: (r: TokenSaverPromptCache) =>
        num(formatTokens(inputTokensPerRun(r))),
    },
  ];
  return (
    <ScrollX label="Prompt cache by run kind">
      <DataTable
        rows={[...rows]}
        getRowId={(r) => r.runKind}
        columns={columns}
        className="min-w-[28rem]"
      />
    </ScrollX>
  );
}
