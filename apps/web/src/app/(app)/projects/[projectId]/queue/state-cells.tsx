import type { QueueItemView } from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Tooltip } from 'glass-ui/tooltip';
import {
  computedNote,
  STATE_TONE,
  safeHttpsUrl,
  sourceLabel,
  stateLabel,
} from '../../../../../lib/queue/format';

export function StateBadge({ item }: { item: QueueItemView }) {
  return <Badge tone={STATE_TONE[item.state]} label={stateLabel(item.state)} />;
}

/** The dot that says whose verdict the state is (D4). */
export function SourceDot({ item }: { item: QueueItemView }) {
  const label = sourceLabel(item);
  return (
    <Tooltip content={label}>
      <span className="inline-flex items-center">
        <Badge
          dot
          tone={item.source === 'orchestrator' ? 'ok' : 'neutral'}
          aria-hidden="true"
        />
        <span className="sr-only">{label}</span>
      </span>
    </Tooltip>
  );
}

export function IssueLink({ item }: { item: QueueItemView }) {
  const href = safeHttpsUrl(item.url);
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

/** The muted "AgentDock computes X" note, only when it differs (D4). */
export function ComputedNote({ item }: { item: QueueItemView }) {
  const note = computedNote(item);
  return note ? <span className="text-xs text-ink-3">{note}</span> : null;
}
