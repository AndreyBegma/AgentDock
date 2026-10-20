'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { Field, Textarea } from '@andrewbehma/glass-ui/field';
import { PLANNER_SUMMARY_MAX, type PlanTaskView } from '@nautelle/shared';
import { useEffect, useState } from 'react';

/**
 * Asks for a rewrite (D9): the comment accumulates on the task, and **Revise
 * plan** later sends every comment in one plan-level turn.
 */
export function RewriteDialog({
  task,
  busy,
  onOpenChange,
  onSubmit,
}: {
  task: PlanTaskView | null;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (comment: string) => Promise<void>;
}) {
  const [comment, setComment] = useState('');
  useEffect(() => {
    setComment(task?.rewriteComment ?? '');
  }, [task]);
  const text = comment.trim();
  const tooLong = text.length > PLANNER_SUMMARY_MAX;

  const submit = async () => {
    if (!text || tooLong || busy) return;
    try {
      await onSubmit(text);
      onOpenChange(false);
    } catch {
      // The caller said why; the dialog stays open.
    }
  };

  return (
    <DialogRoot
      open={task !== null}
      onOpenChange={(o) => !busy && onOpenChange(o)}
    >
      <DialogContent
        title={task ? `Rewrite ${task.key}` : 'Rewrite'}
        description="Say what should change. Comments are collected; Revise plan sends them all in one pass."
        footer={
          <>
            <Button
              variant="glass"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button disabled={busy || !text || tooLong} onClick={submit}>
              {busy ? 'Saving…' : 'Ask for a rewrite'}
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field
            label="What should change"
            htmlFor="rewrite-comment"
            error={
              tooLong ? `At most ${PLANNER_SUMMARY_MAX} characters.` : undefined
            }
          >
            <Textarea
              id="rewrite-comment"
              rows={5}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </Field>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
