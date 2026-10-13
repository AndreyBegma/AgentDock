import type { HeldForLeadRow } from '@agentdock/shared';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import { HELD_FOR_LEAD_HINT } from '../../../../../lib/queue/format';

/** D5: the orchestrator's latest `Held for a lead` table, as written. */
export function HeldForLead({ rows }: { rows: HeldForLeadRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-3" aria-label="Held for a lead">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">Held for a lead</h2>
        <p className="text-sm text-ink-2">{HELD_FOR_LEAD_HINT}</p>
      </div>
      <Table scroll>
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
    </section>
  );
}
