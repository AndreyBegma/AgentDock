'use client';

import type { CreateIssueRequest, CreateIssueResult } from '@agentdock/shared';
import { Button } from 'glass-ui/button';
import { Combobox } from 'glass-ui/combobox';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { Field, Input, Textarea } from 'glass-ui/field';
import { toast } from 'glass-ui/toast';
import { Toggle } from 'glass-ui/toggle';
import { useState } from 'react';
import { api } from '../../../../../lib/api';
import {
  describeQueueError,
  gapSentence,
  queueHint,
} from '../../../../../lib/queue/format';

const TITLE_MAX = 256;
const BODY_MAX = 65_536;

export function NewIssueDialog({
  projectId,
  open,
  labelChoices,
  onOpenChange,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  labelChoices: string[];
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [labels, setLabels] = useState<string[]>([]);
  const [queue, setQueue] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const hint = queueHint(body, labels);
  // A toggle left on while the body stops qualifying is off, not silently sent.
  const queueing = queue && hint.canQueue;
  const valid = title.trim() !== '' && body.length <= BODY_MAX;

  const reset = () => {
    setTitle('');
    setBody('');
    setLabels([]);
    setQueue(false);
    setError(undefined);
  };

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    const request: CreateIssueRequest = {
      title: title.trim(),
      body,
      labels,
      queue: queueing,
    };
    try {
      const result = await api<CreateIssueResult>(
        `/projects/${projectId}/issues`,
        { method: 'POST', body: request },
      );
      toast.success(
        result.queued
          ? `Issue #${result.number} created and queued.`
          : `Issue #${result.number} created.`,
      );
      reset();
      onOpenChange(false);
      onCreated();
    } catch (err) {
      setError(describeQueueError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent
        title="New issue"
        description="Files an issue on the project’s repository through its runner."
        footer={
          <>
            <Button
              variant="glass"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button disabled={busy || !valid} onClick={submit}>
              {busy ? 'Creating…' : 'Create issue'}
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !busy) void submit();
          }}
        >
          <Field label="Title" htmlFor="queue-new-title" required>
            <Input
              id="queue-new-title"
              value={title}
              maxLength={TITLE_MAX}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field label="Body" htmlFor="queue-new-body">
            <Textarea
              id="queue-new-body"
              rows={8}
              value={body}
              maxLength={BODY_MAX}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
          <Field label="Labels">
            <Combobox
              multiple
              aria-label="Labels"
              placeholder="Add a label"
              options={labelChoices.map((l) => ({ value: l, label: l }))}
              value={labels}
              onValueChange={setLabels}
            />
          </Field>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-sm">
              <Toggle
                labelledBy="queue-new-queue"
                checked={queueing}
                onChange={(checked) => {
                  if (hint.canQueue) setQueue(checked);
                }}
              />
              <span id="queue-new-queue">Queue for the orchestrator</span>
            </div>
            <span
              className={`text-xs ${hint.canQueue ? 'text-ink-3' : 'text-ink-2'}`}
            >
              {hint.gap
                ? gapSentence(hint.gap)
                : 'The ready label is added only because the body says what done looks like.'}
            </span>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
