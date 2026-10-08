'use client';

import { Button } from 'glass-ui/button';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { Field, Textarea } from 'glass-ui/field';
import { useState } from 'react';
import {
  COMMAND_PENDING_LABEL,
  describeMessageSize,
  MESSAGE_MAX_BYTES,
  messageProblem,
} from '../../../../../lib/control/format';
import type { useControl } from '../../../../../lib/control/use-control';

/** Message worker and Stop slot of the slot sheet (spec 17 D6–D8). */
export function SlotControls({
  slot,
  control,
}: {
  slot: string;
  control: ReturnType<typeof useControl>;
}) {
  const [text, setText] = useState('');
  const [stopping, setStopping] = useState(false);

  const problem = messageProblem(text);
  const sending = control.busy('slot.message', slot);
  const stopBusy = control.busy('slot.stop', slot);

  const send = async () => {
    if (problem) return;
    const run = await control.message(slot, text);
    // Keep the text when the send failed, so it is not retyped.
    if (run) setText('');
  };

  const stop = async () => {
    setStopping(false);
    await control.stopSlot(slot);
  };

  return (
    <section
      className="flex flex-col gap-4 border-t border-line pt-4"
      aria-label="Control"
    >
      <h3 className="text-sm font-semibold">Control</h3>
      <p className="text-xs text-warn">
        The orchestrator normally speaks to workers. A message sent from here
        bypasses it, so it will not know what was said until it reads the board.
      </p>
      <Field
        label="Message worker"
        htmlFor="slot-message"
        hint={`${describeMessageSize(text)} (UTF-8).`}
        error={
          problem === 'too_long'
            ? `Over the ${MESSAGE_MAX_BYTES / 1024} KB limit.`
            : undefined
        }
      >
        <Textarea
          id="slot-message"
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-invalid={problem === 'too_long'}
        />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="ghost"
          disabled={stopBusy}
          onClick={() => setStopping(true)}
        >
          {stopBusy ? COMMAND_PENDING_LABEL['slot.stop'] : 'Stop slot'}
        </Button>
        <Button
          variant="solid"
          disabled={problem !== null || sending}
          onClick={send}
        >
          {sending ? COMMAND_PENDING_LABEL['slot.message'] : 'Send message'}
        </Button>
      </div>

      <DialogRoot open={stopping} onOpenChange={setStopping}>
        <DialogContent
          title={`Stop slot ${slot}?`}
          description="Only the worker’s session is killed. The worktree and branch are kept; the orchestrator will resume or clean up."
          footer={
            <>
              <Button variant="ghost" onClick={() => setStopping(false)}>
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
    </section>
  );
}
