'use client';

import type { PlanTurnView } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { Spinner } from '@andrewbehma/glass-ui/spinner';
import { useEffect, useState } from 'react';
import { formatDuration } from '../../lib/format';
import { turnActionText } from '../../lib/planner/format';

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
 * Where a running turn's live log line mounts. Plan turns do not stream a
 * log yet (the runner relay is a follow-up to #172), so it renders nothing;
 * the follow-up fills it from the run's `run_log` topic (#24 D13).
 */
export function TurnLogLine(_props: { turn: PlanTurnView }) {
  return null;
}

/**
 * A queued or running turn: a spinner, what the planner is doing, how long
 * it has taken, and Cancel.
 */
export function RunningTurn({
  turn,
  canCancel,
  cancelling,
  onCancel,
}: {
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
        <TurnLogLine turn={turn} />
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
