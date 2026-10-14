'use client';

import type { PlanTurnView } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { Spinner } from '@andrewbehma/glass-ui/spinner';
import { useEffect, useState } from 'react';
import { formatDuration } from '../../lib/format';
import { turnActionText } from '../../lib/planner/format';
import { useRunLog } from '../../lib/skills/use-run-log';

/** Elapsed time moves by the second while a turn runs. */
const ELAPSED_TICK_MS = 1_000;

function useElapsed(since: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(id);
  }, []);
  return Math.max(0, now - Date.parse(since));
}

/**
 * The newest line of a running turn's log, from its run's `run_log` topic
 * (#24 D13, #183); nothing while it is queued or has said nothing yet. It is
 * kept out of the card's live region: a line per second is not announced.
 */
export function TurnLogLine({
  projectId,
  turn,
}: {
  projectId: string;
  turn: PlanTurnView;
}) {
  const { log } = useRunLog(projectId, turn.runId, turn.phase === 'running');
  const last = log.rows.at(-1);
  if (!last) return null;
  return (
    <span
      className="truncate text-xs text-ink-3"
      title={last.text}
      aria-live="off"
    >
      {last.text}
    </span>
  );
}

/**
 * A queued or running turn: a spinner, what the planner is doing, how long
 * it has taken, and Cancel.
 */
export function RunningTurn({
  projectId,
  turn,
  canCancel,
  cancelling,
  onCancel,
}: {
  projectId: string;
  turn: PlanTurnView;
  canCancel: boolean;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const elapsed = useElapsed(turn.createdAt);
  return (
    <Card
      variant="content"
      pad="md"
      className="flex min-w-0 flex-wrap items-center gap-3"
      role="status"
    >
      <Spinner size="sm" label={null} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium text-ink">
          {turn.phase === 'queued'
            ? 'Waiting for a free runner slot…'
            : turnActionText(turn)}
        </span>
        <span className="text-xs text-ink-3 tabular-nums">
          {formatDuration(elapsed)}
        </span>
        <TurnLogLine projectId={projectId} turn={turn} />
      </div>
      {canCancel ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={cancelling}
          onClick={onCancel}
        >
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </Button>
      ) : null}
    </Card>
  );
}
