'use client';

import type { DesignProgressView } from '@agentdock/shared';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { SheetContent, SheetRoot } from '@andrewbehma/glass-ui/sheet';
import { Spinner } from '@andrewbehma/glass-ui/spinner';
import { useEffect, useState } from 'react';
import {
  elapsedSince,
  isStalled,
  progressLabel,
  STARTING,
} from '../../lib/design/progress';
import { formatDuration } from '../../lib/format';
import { useRunLog } from '../../lib/skills/use-run-log';
import { RunLogPanel } from '../runs/run-log-panel';

/** Elapsed time and the stall check move by the second. */
const TICK_MS = 1_000;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * A busy design (#275 D1–D5, D7): the stage, how long the whole job has
 * taken, the newest log line, **Show log** and **Stop**. Five minutes
 * without output raises a "may be stuck" warning above it. The log line is
 * kept out of the live region: a line per second is not announced.
 */
export function DesignProgress({
  projectId,
  progress,
  canStop,
  stopping,
  onStop,
}: {
  projectId: string;
  progress: DesignProgressView;
  canStop: boolean;
  stopping: boolean;
  onStop: () => void;
}) {
  const now = useNow();
  const [logOpen, setLogOpen] = useState(false);
  const running = progress.phase === 'running';
  const { log, lastLineAt } = useRunLog(projectId, progress.runId, running);
  const last = log.rows.at(-1);
  const stalled = isStalled(progress, log.lastOutputAt, lastLineAt, now);

  const stop = canStop ? (
    <Button
      size="sm"
      variant="ghost"
      className="max-lg:h-11"
      disabled={stopping}
      onClick={onStop}
    >
      {stopping ? 'Stopping…' : 'Stop'}
    </Button>
  ) : null;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {stalled ? (
        <Banner tone="warn" action={stop}>
          No output for 5 min — it may be stuck.
        </Banner>
      ) : null}
      <Card
        variant="content"
        pad="md"
        className="flex min-w-0 flex-wrap items-center gap-3 max-lg:[--size-control:44px]"
        role="status"
      >
        <Spinner size="sm" label={null} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium text-ink">
            {progressLabel(progress)}
          </span>
          <span className="text-xs text-ink-3 tabular-nums">
            {formatDuration(elapsedSince(progress.startedAt, now))}
          </span>
          {last ? (
            <span
              className="text-xs text-ink-3 [overflow-wrap:anywhere] max-lg:line-clamp-3 lg:truncate"
              title={last.text}
              aria-live="off"
            >
              {last.text}
            </span>
          ) : null}
        </div>
        {running ? (
          <Button
            size="sm"
            variant="glass"
            className="max-lg:h-11"
            onClick={() => setLogOpen(true)}
          >
            Show log
          </Button>
        ) : null}
        {stalled ? null : stop}
      </Card>
      {logOpen ? (
        <SheetRoot open={logOpen} onOpenChange={setLogOpen}>
          <SheetContent title="Run log" side="bottom">
            <RunLogPanel projectId={projectId} runId={progress.runId} />
          </SheetContent>
        </SheetRoot>
      ) : null}
    </div>
  );
}

/**
 * #606: a busy design with nothing running yet — between two variants, or a
 * batch whose next turn never started. **Stop** puts it back to rest.
 */
export function DesignStarting({
  canStop,
  stopping,
  onStop,
}: {
  canStop: boolean;
  stopping: boolean;
  onStop: () => void;
}) {
  return (
    <Card
      variant="content"
      pad="md"
      className="flex min-w-0 flex-wrap items-center gap-3 max-lg:[--size-control:44px]"
      role="status"
    >
      <Spinner size="sm" label={null} />
      <span className="min-w-0 flex-1 text-sm font-medium text-ink">
        {STARTING}
      </span>
      {canStop ? (
        <Button
          size="sm"
          variant="ghost"
          className="max-lg:h-11"
          disabled={stopping}
          onClick={onStop}
        >
          {stopping ? 'Stopping…' : 'Stop'}
        </Button>
      ) : null}
    </Card>
  );
}
