import { Badge } from '@andrewbehma/glass-ui/badge';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import type { QueueItemView } from '@nautelle/shared';
import {
  computedNote,
  STATE_CHIP_LABEL,
  sourceLabel,
} from '../../../../../lib/queue/format';
import { QUEUE_PILL_STATUS } from '../../../../../lib/status/pill';
import { githubUrl } from '../../../../../lib/url';

/** Where the issue stands: process state, so a pill (#213). */
export function StateBadge({ item }: { item: QueueItemView }) {
  return (
    <StatusPill
      status={QUEUE_PILL_STATUS[item.state]}
      label={STATE_CHIP_LABEL[item.state]}
    />
  );
}

/** The dot that says whose verdict the state is (D4). */
export function SourceDot({ item }: { item: QueueItemView }) {
  const label = sourceLabel(item);
  return (
    <Tooltip content={label}>
      <button type="button" className="inline-flex cursor-help items-center">
        <Badge
          dot
          tone={item.source === 'orchestrator' ? 'ok' : 'neutral'}
          aria-hidden="true"
        />
        <span className="sr-only">{label}</span>
      </button>
    </Tooltip>
  );
}

export function IssueLink({ item }: { item: QueueItemView }) {
  const href = githubUrl(item.url);
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline-offset-2 hover:underline"
    >
      #{item.number}
    </a>
  ) : (
    <>#{item.number}</>
  );
}

/** The muted "Nautelle computes X" note, only when it differs (D4). */
export function ComputedNote({ item }: { item: QueueItemView }) {
  const note = computedNote(item);
  return note ? <span className="text-xs text-ink-3">{note}</span> : null;
}
