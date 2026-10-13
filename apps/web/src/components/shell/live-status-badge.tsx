'use client';

import { Badge } from 'glass-ui/badge';
import { liveStatusLabel, useLivePaused } from './live-status';

/**
 * The page-level badge for the live socket: Live, Reconnecting…, or Live
 * updates paused — never "Offline", which reads as the runner.
 */
export function LiveStatusBadge() {
  const { status, paused } = useLivePaused();
  return (
    <span className="inline-flex items-center gap-2 text-xs text-ink-2">
      <Badge
        dot
        tone={status === 'connected' ? 'ok' : 'warn'}
        aria-hidden="true"
      />
      {liveStatusLabel(status, paused)}
    </span>
  );
}
