import { Badge } from '@andrewbehma/glass-ui/badge';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import type { SessionSummary } from '@nautelle/shared';
import {
  LIVE_STATE_LABEL,
  LIVE_STATE_PILL,
  ORIGIN_LABEL,
  originOf,
} from '../../lib/sessions/format';

type OriginFields = Pick<SessionSummary, 'origin' | 'liveState'>;

/** Where the session came from; a fact about the record, so a `Badge`. */
export function OriginBadge({ session }: { session: OriginFields }) {
  const origin = originOf(session);
  return (
    <Badge
      tone={origin === 'unknown' ? 'neutral' : 'ok'}
      label={ORIGIN_LABEL[origin]}
    />
  );
}

/**
 * What a manual session is doing now, from its hooks. Only manual sessions
 * have a live state worth showing: a worker's state is the slot's.
 */
export function LiveStatePill({ session }: { session: OriginFields }) {
  if (originOf(session) !== 'manual' || !session.liveState) return null;
  return (
    <StatusPill
      size="sm"
      status={LIVE_STATE_PILL[session.liveState]}
      label={LIVE_STATE_LABEL[session.liveState]}
    />
  );
}
