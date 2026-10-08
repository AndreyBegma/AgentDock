'use client';

import { Badge } from 'glass-ui/badge';
import { Chip } from 'glass-ui/chip';
import { type LogLine, LogViewer } from 'glass-ui/log-viewer';
import { useMemo, useState } from 'react';
import {
  PANE_CONNECTION_LABEL,
  type PaneConnection,
} from '../../../../../lib/pane/format';
import { usePane } from '../../../../../lib/pane/use-pane';

const DOT_TONE = {
  connected: 'ok',
  reconnecting: 'warn',
  ended: 'neutral',
} as const satisfies Record<PaneConnection, 'ok' | 'warn' | 'neutral'>;

/**
 * The slot's terminal pane, read-only. Mounted only while the Pane tab is
 * selected, so closing the tab or the sheet unsubscribes (spec 18 UI).
 */
export function PanePanel({
  projectId,
  slot,
}: {
  projectId: string;
  slot: string;
}) {
  const { pane, connection, error } = usePane(projectId, slot, true);
  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState('');

  // The index is the id: a patch replaces the tail, so the same index is the same row.
  const lines = useMemo<LogLine[]>(
    () => pane.lines.map((text, id) => ({ id, text })),
    [pane.lines],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge dot tone={DOT_TONE[connection]} aria-hidden />
        <span className="text-sm" role="status">
          {PANE_CONNECTION_LABEL[connection]}
        </span>
        <Chip size="sm">read-only</Chip>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : (
        <LogViewer
          label={`Pane of ${slot}`}
          lines={lines}
          follow={follow}
          onFollowChange={setFollow}
          query={query}
          onQueryChange={setQuery}
          emptyState={
            <p className="p-3 text-sm text-ink-2">Waiting for output…</p>
          }
          className="h-96"
        />
      )}
    </div>
  );
}
