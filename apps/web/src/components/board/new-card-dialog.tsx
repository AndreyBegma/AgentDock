'use client';

import {
  type BoardSettingsView,
  type BoardView,
  type CreatePlanRequest,
  claudeModelOptions,
  type PlanSummary,
  type ProjectDetail,
} from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { Field, Select, Textarea } from '@andrewbehma/glass-ui/field';
import { useEffect, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { describeUploadFailure } from '../../lib/attachments/format';
import { useAttachmentUploads } from '../../lib/attachments/use-attachment-uploads';
import { INTAKE_BRIEF_MAX } from '../../lib/board/intake';
import { describePlannerError } from '../../lib/planner/format';
import { runnerGate, runnerGateCopy } from '../../lib/planner/runner-support';
import {
  preselectedModel,
  useUserSettings,
} from '../../lib/settings/user-settings';
import { AttachmentDropzone } from '../attachments/attachment-dropzone';
import { DisabledReason } from '../prerequisites/disabled-reason';
import { IntakeView } from './intake-view';

/**
 * New Card (#337 D2): one field, **What to do**, in any language, with
 * attachments and the planning model. **Start** creates a `card`-mode plan
 * and its first intake turn; the dialog then becomes the interview
 * (`IntakeView`). Closing it keeps the intake as a draft on the Board.
 */
export function NewCardDialog({
  projectId,
  project,
  open,
  planId: controlledId,
  board,
  onOpenChange,
  onStarted,
  onCreated,
}: {
  projectId: string;
  /** The runner gate reads it; absent, Start is not gated before the API answers. */
  project?: ProjectDetail;
  open: boolean;
  /**
   * The intake shown, when the caller keeps it (the Board's `?intake=`, a
   * Drafts Resume). Without it the dialog keeps the one it started.
   */
  planId?: string;
  /** Where the generated card is found by its `planId`; fetched when absent. */
  board?: BoardView;
  /**
   * The Work list still passes its board settings; the generated card takes
   * the project's own (#337 D6), so they are not read.
   */
  settings?: BoardSettingsView;
  onOpenChange: (open: boolean) => void;
  onStarted?: (planId: string) => void;
  /** **Open the card** once the intake wrote it. */
  onCreated: (number: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [startedId, setStartedId] = useState<string>();
  const planId = controlledId ?? startedId;
  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) setStartedId(undefined);
        onOpenChange(next);
      }}
    >
      <DialogContent
        title="New card"
        description={
          planId
            ? 'The planner asks until the task is clear, then writes the card in English. Close this to keep it as a draft.'
            : 'Say what to do, in any language. The planner asks what it needs, then writes the card.'
        }
        className="sm:max-w-2xl"
      >
        {planId ? (
          <IntakeView
            projectId={projectId}
            planId={planId}
            board={board}
            onOpenCard={(number) => {
              setStartedId(undefined);
              onCreated(number);
            }}
            onClose={() => {
              setStartedId(undefined);
              onOpenChange(false);
            }}
          />
        ) : (
          <StartForm
            projectId={projectId}
            project={project}
            open={open}
            busy={busy}
            setBusy={setBusy}
            onCancel={() => onOpenChange(false)}
            onStarted={(id) => {
              setStartedId(id);
              onStarted?.(id);
            }}
          />
        )}
      </DialogContent>
    </DialogRoot>
  );
}

function StartForm({
  projectId,
  project,
  open,
  busy,
  setBusy,
  onCancel,
  onStarted,
}: {
  projectId: string;
  project?: ProjectDetail;
  open: boolean;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onCancel: () => void;
  onStarted: (planId: string) => void;
}) {
  const settings = useUserSettings(open);
  const [what, setWhat] = useState('');
  const [model, setModel] = useState<string>();
  const [error, setError] = useState<string>();
  const uploads = useAttachmentUploads(projectId);

  // D9: the person's planning model, until they pick another for this card.
  const preselected = preselectedModel(settings.data);
  useEffect(() => {
    if (!open) setModel(undefined);
  }, [open]);
  const picked = model ?? preselected;

  const gate = runnerGate(project, 'planner');
  const gateCopy = gate ? runnerGateCopy('planner', gate) : null;
  // Start waits for every upload (#309 UI), so no file is left behind.
  const valid = what.trim() !== '' && !uploads.busy && gate === null && !busy;

  const start = async () => {
    if (!valid) return;
    setBusy(true);
    setError(undefined);
    const request: CreatePlanRequest = {
      brief: what.trim(),
      mode: 'card',
      model: picked,
      ...(uploads.done.length > 0
        ? { attachmentIds: uploads.done.map((d) => d.view.id) }
        : {}),
    };
    try {
      const plan = await api<PlanSummary>(`/projects/${projectId}/plans`, {
        method: 'POST',
        body: request,
      });
      setWhat('');
      uploads.forget(uploads.done.map((d) => d.item));
      onStarted(plan.id);
    } catch (err) {
      setError(
        err instanceof ApiError && err.body?.error === 'attachment_error'
          ? describeUploadFailure(err.status, err.body)
          : describePlannerError(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <Field
        label="What to do"
        htmlFor="board-new-what"
        hint="In your own words and your own language. No title: the card gets one."
      >
        <Textarea
          id="board-new-what"
          rows={8}
          value={what}
          maxLength={INTAKE_BRIEF_MAX}
          disabled={busy}
          onChange={(e) => setWhat(e.target.value)}
        />
      </Field>
      <section aria-label="Attachments" className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Attachments</span>
        <AttachmentDropzone
          uploads={uploads}
          label="Attach files for the planner and the card"
        />
      </section>
      <Field
        label="Model"
        htmlFor="board-new-model"
        hint="Your planning model from Account settings; this pick is for this card only."
      >
        <Select
          id="board-new-model"
          value={picked}
          disabled={busy}
          onChange={(e) => setModel(e.target.value)}
        >
          {claudeModelOptions({ selected: picked }).map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </Select>
      </Field>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {gateCopy ? (
        <DisabledReason href={gateCopy.href} cta={gateCopy.cta}>
          {gateCopy.reason}
        </DisabledReason>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="glass" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid}>
          {busy ? 'Starting…' : 'Start'}
        </Button>
      </div>
    </form>
  );
}
