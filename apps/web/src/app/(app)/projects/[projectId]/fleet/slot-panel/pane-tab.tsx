'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { PanePanel } from '../pane-panel';

/** The live pane the slot sheet had, and terminal attach beside it. */
export function PaneTab({
  projectId,
  slot,
  ended,
  onAttach,
}: {
  projectId: string;
  slot: string;
  ended: boolean;
  /** Admins on a runner that can attach; absent hides the action. */
  onAttach?: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      {onAttach && !ended ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-ink-2">
            Attach opens read-only. Taking control is a separate step, and every
            attach is audited.
          </p>
          <Button variant="glass" size="sm" onClick={onAttach}>
            Attach terminal
          </Button>
        </div>
      ) : null}
      {ended ? (
        <p className="text-sm text-ink-2">
          This slot has ended; its session is gone, so there is no pane.
        </p>
      ) : (
        <PanePanel projectId={projectId} slot={slot} />
      )}
    </div>
  );
}
