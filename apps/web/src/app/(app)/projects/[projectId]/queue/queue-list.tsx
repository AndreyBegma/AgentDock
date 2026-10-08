import type { QueueItemView } from '@agentdock/shared';
import { Button } from 'glass-ui/button';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { blockerLabel, priorityLabel } from '../../../../../lib/queue/format';
import { ComputedNote, IssueLink, SourceDot, StateBadge } from './state-cells';

export function QueueList({
  items,
  onSelect,
}: {
  items: QueueItemView[];
  onSelect: (item: QueueItemView) => void;
}) {
  return (
    <Table scroll>
      <TableHead>
        <TableRow>
          <TableCell head>Issue</TableCell>
          <TableCell head>Title</TableCell>
          <TableCell head>State</TableCell>
          <TableCell head>Why / what would clear it</TableCell>
          <TableCell head>Priority</TableCell>
          <TableCell head>
            <span className="sr-only">Details</span>
          </TableCell>
        </TableRow>
      </TableHead>
      <tbody>
        {items.map((item) => (
          <TableRow key={item.number}>
            <TableCell>
              <IssueLink item={item} />
            </TableCell>
            <TableCell>
              <span className="font-medium">{item.title}</span>
              {item.waveSlots && item.waveSlots.length > 0 ? (
                <span className="block text-xs text-ink-3">
                  {item.waveSlots
                    .map(
                      (s) =>
                        `${s.slot}${s.lead ? ' (lead)' : ''}${s.model ? ` · ${s.model}` : ''}`,
                    )
                    .join(', ')}
                </span>
              ) : null}
            </TableCell>
            <TableCell>
              <span className="flex flex-col items-start gap-1">
                <span className="inline-flex items-center gap-2">
                  <StateBadge item={item} />
                  <SourceDot item={item} />
                </span>
                <ComputedNote item={item} />
              </span>
            </TableCell>
            <TableCell>
              <span className="block">{item.why || '—'}</span>
              {item.clears ? (
                <span className="block text-xs text-ink-2">
                  Clears when: {item.clears}
                </span>
              ) : null}
              {item.blockers.length > 0 ? (
                <span className="block text-xs text-ink-3">
                  Depends on {item.blockers.map(blockerLabel).join(', ')}
                </span>
              ) : null}
            </TableCell>
            <TableCell>{priorityLabel(item.priority)}</TableCell>
            <TableCell>
              <div className="flex justify-end">
                <Button
                  variant="glass"
                  size="sm"
                  aria-label={`Details for issue ${item.number}`}
                  onClick={() => onSelect(item)}
                >
                  Details
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </tbody>
    </Table>
  );
}
