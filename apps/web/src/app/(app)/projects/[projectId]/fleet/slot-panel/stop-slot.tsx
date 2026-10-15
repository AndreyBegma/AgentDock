'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { useState } from 'react';
import { COMMAND_PENDING_LABEL } from '../../../../../../lib/control/format';
import type { useControl } from '../../../../../../lib/control/use-control';
import { PendingLabel } from '../pending-label';

/** Stop slot, with the confirmation the slot sheet had (spec 17 D8, #213). */
export function StopSlot({
  slot,
  control,
}: {
  slot: string;
  control: ReturnType<typeof useControl>;
}) {
  const [open, setOpen] = useState(false);
  const busy = control.busy('slot.stop', slot);

  const stop = async () => {
    await control.stopSlot(slot);
    setOpen(false);
  };

  return (
    <>
      <div className="flex items-center gap-2">
        {busy ? (
          <PendingLabel label={COMMAND_PENDING_LABEL['slot.stop']} />
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => setOpen(true)}
        >
          Stop slot
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Stop slot ${slot}?`}
        consequence="Only the worker’s session is killed, and unsaved work in it is lost. The worktree, the branch and the commits are kept; the orchestrator will resume or clean up."
        verb="Stop"
        busy={busy}
        onConfirm={stop}
      />
    </>
  );
}
