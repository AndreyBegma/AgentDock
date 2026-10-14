'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { useState } from 'react';
import { COMMAND_PENDING_LABEL } from '../../../../../../lib/control/format';
import type { useControl } from '../../../../../../lib/control/use-control';
import { PendingLabel } from '../pending-label';

/** Stop slot, with the confirmation the slot sheet had (spec 17 D8). */
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
    setOpen(false);
    await control.stopSlot(slot);
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
      <DialogRoot open={open} onOpenChange={setOpen}>
        <DialogContent
          title={`Stop slot ${slot}?`}
          description="Only the worker’s session is killed. The worktree and branch are kept; the orchestrator will resume or clean up."
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant="solid" onClick={stop}>
                Stop slot
              </Button>
            </>
          }
        >
          <p className="text-sm text-ink-2">
            Unsaved work in the session is lost; commits are not.
          </p>
        </DialogContent>
      </DialogRoot>
    </>
  );
}
