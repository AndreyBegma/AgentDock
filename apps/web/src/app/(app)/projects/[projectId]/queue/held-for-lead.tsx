import { Badge } from '@andrewbehma/glass-ui/badge';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import type { HeldForLeadRow } from '@nautelle/shared';
import { ScrollX } from '../../../../../components/scroll-x/scroll-x';
import {
  HELD_FOR_LEAD_HINT,
  heldForLeadSummary,
} from '../../../../../lib/queue/format';

/** D5: the orchestrator's latest `Held for a lead` table, as written. */
export function HeldForLead({ rows }: { rows: HeldForLeadRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-3" aria-label="Held for a lead">
      <div className="flex flex-col gap-1">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          Held for a lead
          <Badge count={rows.length} aria-label={`${rows.length} held`} />
        </h2>
        <p className="text-sm text-ink-2">{HELD_FOR_LEAD_HINT}</p>
        <p className="text-xs text-ink-3">{heldForLeadSummary(rows.length)}</p>
      </div>
      <ScrollX label="Held for a lead" edgeClassName="from-surface">
        <Table>
          <TableHead>
            <TableRow>
              <TableCell head>Slot</TableCell>
              <TableCell head>Waiting on</TableCell>
              <TableCell head>Dispatch when</TableCell>
            </TableRow>
          </TableHead>
          <tbody>
            {rows.map((row) => (
              <TableRow key={`${row.slot}-${row.waitingOn}`}>
                <TableCell>{row.slot}</TableCell>
                <TableCell>{row.waitingOn || '—'}</TableCell>
                <TableCell>{row.dispatchWhen || '—'}</TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      </ScrollX>
    </section>
  );
}
