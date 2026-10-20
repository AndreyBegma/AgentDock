'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import {
  DataTable,
  type DataTableSort,
  sortRows,
} from '@andrewbehma/glass-ui/data-table';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import type { UsageBreakdownRow, UsageDimension } from '@nautelle/shared';
import { type ReactNode, useMemo, useState } from 'react';
import { ScrollX } from '../../../components/scroll-x/scroll-x';
import {
  costOrBlank,
  DIMENSION_LABEL,
  formatCount,
  formatTokens,
  groupLabel,
  MACHINE_WIDE_HINT,
} from '../../../lib/usage/format';

const tokensOf = (t: UsageBreakdownRow): number =>
  t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;

/**
 * The breakdown by one dimension, sortable. A row that can narrow the page
 * (`onDrill`) does so inside Usage (#213) — never off to Fleet.
 */
export function BreakdownTable({
  dimension,
  rows,
  loading,
  empty,
  onDrill,
}: {
  dimension: UsageDimension;
  rows: UsageBreakdownRow[];
  loading: boolean;
  empty: ReactNode;
  /** Narrows the page on the row; unset when no row has anywhere to go. */
  onDrill?: (row: UsageBreakdownRow) => void;
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
        onRowActivate={onDrill}
        loading={loading}
        emptyState={empty}
        className="min-w-[36rem]"
      />
    </ScrollX>
  );
}
