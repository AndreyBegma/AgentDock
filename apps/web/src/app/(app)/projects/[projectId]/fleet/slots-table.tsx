import type { SlotSummary } from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Button } from 'glass-ui/button';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { Tooltip } from 'glass-ui/tooltip';
import {
  CHECKS_LABEL,
  CHECKS_TONE,
  checkpointLabel,
  formatAge,
  formatAheadBehind,
  issueUrl,
  SLOT_STATUS_LABEL,
  SLOT_STATUS_TONE,
  safeHttpsUrl,
} from '../../../../../lib/fleet/format';

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
    <>{text}</>
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
    <Table scroll>
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
          <TableCell head>
            <span className="sr-only">Details</span>
          </TableCell>
        </TableRow>
      </TableHead>
      <tbody>
        {slots.map((slot) => (
          <TableRow key={slot.id}>
            <TableCell>
              <span className="font-medium">{slot.name}</span>
              {slot.lead ? (
                <span className="ml-2 text-xs text-ink-3">lead</span>
              ) : null}
            </TableCell>
            <TableCell>
              <IssueCell slot={slot} />
            </TableCell>
            <TableCell>
              <ModelCell slot={slot} />
            </TableCell>
            <TableCell>
              <Badge
                tone={SLOT_STATUS_TONE[slot.status]}
                label={SLOT_STATUS_LABEL[slot.status]}
              />
            </TableCell>
            <TableCell>{checkpointLabel(slot.lastCheckpoint)}</TableCell>
            <TableCell>
              <PrCell slot={slot} />
            </TableCell>
            <TableCell>{formatAheadBehind(slot.ahead, slot.behind)}</TableCell>
            <TableCell>{formatAge(slot.endedAt ?? slot.startedAt)}</TableCell>
            <TableCell>
              <div className="flex justify-end">
                <Button
                  variant="glass"
                  size="sm"
                  aria-label={`Details for slot ${slot.name}`}
                  onClick={() => onSelect(slot)}
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
