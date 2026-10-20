import { type Column, DataTable } from '@andrewbehma/glass-ui/data-table';
import type { ReactNode } from 'react';

function StackedColumns<Row>({
  row,
  columns,
}: {
  row: Row;
  columns: Column<Row>[];
}) {
  const [first, ...rest] = columns;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {first ? (
        <div className="min-w-0 font-medium">{first.cell(row)}</div>
      ) : null}
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-xs text-ink-2">
        {rest.map((column) => (
          <div key={column.id} className="col-span-2 grid grid-cols-subgrid">
            <dt className="text-ink-3">{column.header}</dt>
            <dd className="min-w-0 text-right">{column.cell(row)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * Where the table gives way to stacked rows. Static class names, so Tailwind
 * sees them in the source.
 */
const SWITCH = {
  tablet: { table: 'max-tablet:hidden', rows: 'tablet:hidden' },
  desktop: { table: 'max-desktop:hidden', rows: 'desktop:hidden' },
} as const;

/**
 * A list of the same record that is a table from tablet up and stacked rows
 * on a phone (stack S-7), so nothing scrolls sideways at 375 px. The switch is
 * CSS only (`max-tablet:` / `tablet:`), so the server HTML is right at every
 * width. `stacked` draws one row for the phone; the table keeps its columns.
 * A table too wide for a tablet's content column passes `stackBelow="desktop"`
 * and is stacked on a tablet too (C-301).
 */
export function ResponsiveRows<Row>({
  label,
  rows,
  getRowId,
  columns,
  stacked,
  onRowActivate,
  stackBelow = 'tablet',
}: {
  label: string;
  rows: Row[];
  getRowId: (row: Row) => string;
  columns: Column<Row>[];
  /** The phone row; by default the first column on top, the rest as label: value. */
  stacked?: (row: Row) => ReactNode;
  onRowActivate?: (row: Row) => void;
  /** The narrowest width that still gets the table. */
  stackBelow?: keyof typeof SWITCH;
}) {
  const at = SWITCH[stackBelow];
  return (
    <>
      <div className={at.table}>
        <DataTable
          rows={rows}
          getRowId={getRowId}
          columns={columns}
          stickyHeader={false}
          onRowActivate={onRowActivate}
        />
      </div>
      <ul
        aria-label={label}
        className={`surface-content ${at.rows} divide-y divide-line overflow-hidden rounded-xl`}
      >
        {rows.map((row) => (
          <li key={getRowId(row)} className="min-w-0 px-4 py-3">
            {stacked ? (
              stacked(row)
            ) : (
              <StackedColumns row={row} columns={columns} />
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
