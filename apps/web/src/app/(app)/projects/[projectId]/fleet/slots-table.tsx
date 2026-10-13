import type { SlotSummary } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import { ScrollX } from '../../../../../components/scroll-x/scroll-x';
import {
  CHECKS_LABEL,
  CHECKS_TONE,
  checkpointLabel,
  formatAheadBehind,
  issueUrl,
  SLOT_STATUS_LABEL,
  SLOT_TERM_HINT,
  safeHttpsUrl,
} from '../../../../../lib/fleet/format';
import { Time } from '../../../../../lib/format/time';
import { slotHue } from '../../../../../lib/hue';
import { SLOT_PILL_STATUS } from '../../../../../lib/status/pill';

function IssueCell({ slot }: { slot: SlotSummary }) {
  if (slot.issue === null) return <>—</>;
  const href = safeHttpsUrl(issueUrl(slot.issue, slot.prUrl));
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline-offset-2 hover:underline"
    >
      #{slot.issue}
    </a>
  ) : (
    <>#{slot.issue}</>
  );
}

function ModelCell({ slot }: { slot: SlotSummary }) {
  const text = `${slot.runtime} · ${slot.model ?? 'model unknown'}`;
  return slot.modelWhy ? (
    <Tooltip content={slot.modelWhy}>
      <button type="button" className="cursor-help underline decoration-dotted">
        {text}
      </button>
    </Tooltip>
  ) : (
    text
  );
}

function PrCell({ slot }: { slot: SlotSummary }) {
  if (slot.prNumber === null) return <>—</>;
  const href = safeHttpsUrl(slot.prUrl);
  return (
    <span className="inline-flex items-center gap-2">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="underline-offset-2 hover:underline"
        >
          #{slot.prNumber}
        </a>
      ) : (
        <>#{slot.prNumber}</>
      )}
      {slot.prChecks ? (
        <>
          <Badge dot tone={CHECKS_TONE[slot.prChecks]} aria-hidden="true" />
          <span className="sr-only">{CHECKS_LABEL[slot.prChecks]}</span>
        </>
      ) : null}
    </span>
  );
}

export function SlotsTable({
  slots,
  onSelect,
}: {
  slots: SlotSummary[];
  onSelect: (slot: SlotSummary) => void;
}) {
  return (
    <ScrollX label="Slots" edgeClassName="from-surface">
      <Table>
        <TableHead>
          <TableRow>
            <TableCell head>Slot</TableCell>
            <TableCell head>Issue</TableCell>
            <TableCell head>Runtime / model</TableCell>
            <TableCell head>Status</TableCell>
            <TableCell head>Last checkpoint</TableCell>
            <TableCell head>PR</TableCell>
            <TableCell head>Ahead / behind</TableCell>
            <TableCell head>Age</TableCell>
          </TableRow>
        </TableHead>
        <tbody>
          {slots.map((slot) => (
            <TableRow
              key={slot.id}
              className="cursor-pointer hover:bg-hover"
              onClick={(event) => {
                // A link or button inside the row keeps its own action.
                if ((event.target as HTMLElement).closest('a, button')) return;
                onSelect(slot);
              }}
            >
              <TableCell>
                {/* The slot's identity colour, the same in every view (#163). */}
                <Badge
                  dot
                  hue={slotHue(slot.name)}
                  aria-hidden="true"
                  className="mr-2"
                />
                <button
                  type="button"
                  className="text-start font-medium underline-offset-2 hover:underline"
                  aria-label={`Open slot ${slot.name}`}
                  onClick={() => onSelect(slot)}
                >
                  {slot.name}
                </button>
                {slot.lead ? (
                  <Tooltip content={SLOT_TERM_HINT.lead}>
                    <button
                      type="button"
                      className="ml-2 cursor-help text-xs text-ink-3"
                    >
                      lead
                    </button>
                  </Tooltip>
                ) : null}
              </TableCell>
              <TableCell>
                <IssueCell slot={slot} />
              </TableCell>
              <TableCell>
                <ModelCell slot={slot} />
              </TableCell>
              <TableCell>
                <StatusPill
                  size="md"
                  status={SLOT_PILL_STATUS[slot.status]}
                  label={SLOT_STATUS_LABEL[slot.status]}
                />
              </TableCell>
              <TableCell>{checkpointLabel(slot.lastCheckpoint)}</TableCell>
              <TableCell>
                <PrCell slot={slot} />
              </TableCell>
              <TableCell>
                {formatAheadBehind(slot.ahead, slot.behind)}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <Time value={slot.endedAt ?? slot.startedAt} />
              </TableCell>
            </TableRow>
          ))}
        </tbody>
      </Table>
    </ScrollX>
  );
}
