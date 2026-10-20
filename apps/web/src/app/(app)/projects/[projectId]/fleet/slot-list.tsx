import { Badge } from '@andrewbehma/glass-ui/badge';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import type { SlotSummary } from '@nautelle/shared';
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
    // `relative`: the sr-only label is absolutely positioned, and without an
    // anchor inside the table's scroller it escapes it and widens the page.
    <span className="relative inline-flex items-center gap-2">
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

/**
 * The slots as stacked rows (the calm Fleet, C-283): identity and status on
 * the first line, the issue and its model on the second, the facts the table
 * used to carry — checkpoint, PR, ahead/behind, age — on the third. Each row
 * wraps, so nothing scrolls sideways on a phone, and opens the agent panel.
 */
export function SlotList({
  slots,
  focus,
  onSelect,
}: {
  slots: SlotSummary[];
  /** The slot whose panel is open, marked in the list. */
  focus?: string | null;
  onSelect: (slot: SlotSummary) => void;
}) {
  return (
    <ul className="flex flex-col divide-y divide-line" aria-label="Slots">
      {slots.map((slot) => (
        // biome-ignore lint/a11y/useKeyWithClickEvents: the name button inside the row is the keyboard path; the row click is a pointer convenience.
        <li
          key={slot.id}
          aria-current={focus === slot.name ? 'true' : undefined}
          className={`flex cursor-pointer flex-col gap-1.5 px-4 py-3 hover:bg-hover ${
            focus === slot.name ? 'bg-accent-soft' : ''
          }`}
          onClick={(event) => {
            // A link or button inside the row keeps its own action.
            if ((event.target as HTMLElement).closest('a, button')) return;
            onSelect(slot);
          }}
        >
          <div className="flex min-w-0 items-center gap-2">
            {/* The slot's identity colour, the same in every view (#163). */}
            <Badge dot hue={slotHue(slot.name)} aria-hidden="true" />
            <button
              type="button"
              className="min-w-0 truncate text-start font-mono text-sm font-medium underline-offset-2 hover:underline"
              aria-label={`Open slot ${slot.name}`}
              onClick={() => onSelect(slot)}
            >
              {slot.name}
            </button>
            {slot.lead ? (
              <Tooltip content={SLOT_TERM_HINT.lead}>
                <button
                  type="button"
                  className="cursor-help text-xs text-ink-3"
                >
                  lead
                </button>
              </Tooltip>
            ) : null}
            <span className="flex-1" />
            <StatusPill
              size="md"
              status={SLOT_PILL_STATUS[slot.status]}
              label={SLOT_STATUS_LABEL[slot.status]}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-2 text-sm text-ink-2">
            <IssueCell slot={slot} />
            <span aria-hidden="true">·</span>
            <ModelCell slot={slot} />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
            <span>{checkpointLabel(slot.lastCheckpoint)}</span>
            {slot.prNumber !== null ? (
              <span>
                PR <PrCell slot={slot} />
              </span>
            ) : null}
            <span>{formatAheadBehind(slot.ahead, slot.behind)}</span>
            <span className="whitespace-nowrap">
              <Time value={slot.endedAt ?? slot.startedAt} />
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
