import type { QueueItemView } from '@agentdock/shared';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import { ScrollX } from '../../../../../components/scroll-x/scroll-x';
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
    <ScrollX label="Queue" edgeClassName="from-surface">
      <Table>
        <TableHead>
          <TableRow>
            <TableCell head>Issue</TableCell>
            <TableCell head>Title</TableCell>
            <TableCell head>State</TableCell>
            <TableCell head>Why / what would clear it</TableCell>
            <TableCell head>Priority</TableCell>
          </TableRow>
        </TableHead>
        <tbody>
          {items.map((item) => (
            <TableRow
              key={item.number}
              className="cursor-pointer hover:bg-hover"
              onClick={(event) => {
                // A link or button inside the row keeps its own action.
                if ((event.target as HTMLElement).closest('a, button')) return;
                onSelect(item);
              }}
            >
              <TableCell>
                <IssueLink item={item} />
              </TableCell>
              <TableCell>
                <button
                  type="button"
                  className="text-start font-medium underline-offset-2 hover:underline"
                  aria-label={`Open issue ${item.number}: ${item.title}`}
                  onClick={() => onSelect(item)}
                >
                  {item.title}
                </button>
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
            </TableRow>
          ))}
        </tbody>
      </Table>
    </ScrollX>
  );
}
