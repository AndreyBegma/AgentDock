'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Chip } from '@andrewbehma/glass-ui/chip';
import { type LogLine, LogViewer } from '@andrewbehma/glass-ui/log-viewer';
import { useEffect, useMemo, useRef, useState } from 'react';
import { rowText } from '../../lib/skills/run-log';
import { useRunLog } from '../../lib/skills/use-run-log';
import { useNarrow } from '../shell/narrow';

/**
 * The run’s rendered log, read-only. Mounted only while the run is active, so
 * a finished run never subscribes. The lines live in memory only; the stream
 * stays on the runner (spec 24 D13). Shared by the skill run page and the
 * design page's Show log (#275 D3).
 */
export function RunLogPanel({
  projectId,
  runId,
  onEnded,
}: {
  projectId: string;
  runId: string;
  /** The runner sent the `ended` frame; the page re-reads the run. */
  onEnded?: () => void;
}) {
  const { log, connected, error } = useRunLog(projectId, runId, true);
  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState('');
  const notified = useRef(false);
  // #526: on a phone the lines wrap, so nothing scrolls sideways.
  const narrow = useNarrow();

  useEffect(() => {
    if (log.endedPhase && !notified.current) {
      notified.current = true;
      onEnded?.();
    }
  }, [log.endedPhase, onEnded]);

  const lines = useMemo<LogLine[]>(
    () => log.rows.map((row) => ({ id: row.id, text: rowText(row) })),
    [log.rows],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          dot
          tone={log.endedPhase ? 'neutral' : connected ? 'ok' : 'warn'}
          aria-hidden
        />
        <span className="text-sm" role="status">
          {log.endedPhase ? 'Run ended' : connected ? 'Live' : 'Reconnecting'}
        </span>
        <Chip size="sm">read-only</Chip>
        {log.trimmed ? <Chip size="sm">older lines are not shown</Chip> : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : (
        <LogViewer
          label="Run log"
          lines={lines}
          defaultWrap={narrow}
          follow={follow}
          onFollowChange={setFollow}
          query={query}
          onQueryChange={setQuery}
          emptyState={
            <p className="p-3 text-sm text-ink-2">Waiting for output…</p>
          }
          className="h-[min(24rem,55dvh)]"
        />
      )}
    </div>
  );
}
