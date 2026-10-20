'use client';

import type { ApproveRequest, RequestChangesRequest } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { Field, Textarea } from '@andrewbehma/glass-ui/field';
import { toast } from '@andrewbehma/glass-ui/toast';
import { useState } from 'react';
import { api } from '../../../../../lib/api';
import {
  describeApprovalHint,
  movedHead,
  noteBytes,
  noteError,
} from '../../../../../lib/approvals/format';
import { useErrorToast } from '../../../../../lib/section/use-error-toast';

const NOTE_MAX_BYTES = 4096;

interface DialogProps {
  projectId: string;
  /** Named in the remedy when the runner is too old. */
  runnerName?: string | null;
  pr: number;
  /** The head the person saw — what the decision binds to (D6). */
  headSha: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After a decision, and after a `head_moved` refusal: refetch. */
  onChanged: () => void;
}

export function ApproveDialog({
  projectId,
  runnerName,
  pr,
  headSha,
  open,
  onOpenChange,
  onChanged,
}: DialogProps) {
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();

  const submit = async () => {
    setBusy(true);
    const body: ApproveRequest = { headSha };
    try {
      await api(`/projects/${projectId}/approvals/${pr}/approve`, {
        method: 'POST',
        body,
      });
      toast.success(
        `Pull request #${pr} approved. The orchestrator may merge.`,
      );
      onOpenChange(false);
      onChanged();
    } catch (err) {
      showError(describeApprovalHint(err, runnerName));
      if (movedHead(err)) {
        onOpenChange(false);
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Approve #${pr}?`}
      consequence={
        <>
          Lets the orchestrator merge this pull request; AgentDock never merges
          itself. The approval is bound to commit{' '}
          <code className="font-mono text-xs">{headSha.slice(0, 12)}</code>, and
          a later push voids it.
        </>
      }
      verb="Approve"
      tone="default"
      busy={busy}
      onConfirm={() => void submit()}
    />
  );
}

export function RequestChangesDialog({
  projectId,
  runnerName,
  pr,
  headSha,
  open,
  onOpenChange,
  onChanged,
}: DialogProps) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();

  const problem = noteError(note);

  const submit = async () => {
    if (problem) return;
    setBusy(true);
    const body: RequestChangesRequest = { headSha, note };
    try {
      await api(`/projects/${projectId}/approvals/${pr}/request-changes`, {
        method: 'POST',
        body,
      });
      toast.success(
        `Changes requested on #${pr}. The note goes to the worker.`,
      );
      setNote('');
      onOpenChange(false);
      onChanged();
    } catch (err) {
      showError(describeApprovalHint(err, runnerName));
      if (movedHead(err)) {
        onOpenChange(false);
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        title={`Request changes on #${pr}`}
        description="The note goes back to the worker through the orchestrator."
        footer={
          <>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button disabled={busy || problem !== null} onClick={submit}>
              {busy ? 'Sending…' : 'Request changes'}
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void submit();
          }}
        >
          <Field label="Note" htmlFor="approval-note" required>
            <Textarea
              id="approval-note"
              rows={6}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <span
            className={`text-xs ${noteBytes(note) > NOTE_MAX_BYTES ? 'text-danger' : 'text-ink-3'}`}
          >
            {noteBytes(note)} / {NOTE_MAX_BYTES} bytes
          </span>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
