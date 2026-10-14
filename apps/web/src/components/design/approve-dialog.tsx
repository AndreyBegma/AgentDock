'use client';

import type { DesignRevisionView } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { Radio, RadioGroup } from '@andrewbehma/glass-ui/radio-group';
import { useEffect, useState } from 'react';
import { revisionLabel } from '../../lib/design/format';

const CONSEQUENCE =
  'The planner then writes the task with this design, and the approved mockup is published next to its specification.';

/**
 * **Approve** (spec 223 D4): with one variant in play, a confirmation; with
 * several, the person picks one — the others are archived, readable and
 * never published.
 */
export function ApproveDialog({
  open,
  onOpenChange,
  candidates,
  inView,
  busy,
  onApprove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The latest revision of each variant in play, by variant. */
  candidates: readonly DesignRevisionView[];
  /** The revision in view, picked by default. */
  inView: DesignRevisionView | null;
  busy: boolean;
  onApprove: (revisionId: string) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setPicked(
        candidates.find((c) => c.variant === inView?.variant)?.id ?? null,
      );
    }
  }, [open, candidates, inView]);

  if (candidates.length <= 1) {
    const only = candidates[0] ?? inView;
    return (
      <ConfirmDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Approve this design?"
        consequence={CONSEQUENCE}
        verb="Approve"
        busy={busy}
        onConfirm={() => {
          if (only) onApprove(only.id);
        }}
      />
    );
  }

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Which variant do you approve?"
        description={`The other variants are archived: still readable, never published. ${CONSEQUENCE}`}
        footer={
          <div className="flex justify-between gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="solid"
              disabled={picked === null || busy}
              onClick={() => {
                if (picked) onApprove(picked);
              }}
            >
              {busy ? 'Approving…' : 'Approve'}
            </Button>
          </div>
        }
      >
        <RadioGroup label="Variant">
          {candidates.map((c) => (
            <Radio
              key={c.id}
              name="approve-variant"
              value={c.id}
              checked={picked === c.id}
              onChange={() => setPicked(c.id)}
              label={`${revisionLabel(c.variant, c.revision)} — ${c.title}`}
              hint={c.rationale}
            />
          ))}
        </RadioGroup>
      </DialogContent>
    </DialogRoot>
  );
}
