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
import { type ReactNode, useEffect, useState } from 'react';
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
import { useWide } from '../../lib/slot/use-wide';
import { AttachmentDropzone } from '../attachments/attachment-dropzone';
import { FullScreenLayer } from '../design/full-screen-layer';
import { DisabledReason } from '../prerequisites/disabled-reason';
import { IntakeView } from './intake-view';

/**
 * New work (#337 D2, #409): one field, **What to do**, in any language, with
 * attachments and the planning model. **Start** creates a `card`-mode plan
 * and its first intake turn; the dialog then becomes the interview
 * (`IntakeView`), which ends in one card or a split into several. Closing it
 * keeps the intake as a draft on the Board. Below `lg` it is a full-screen
 * layer with the phone back bar instead of a dialog (#678).
 */
export function NewCardDialog({
  projectId,
  project,
  open,
  planId: controlledId,
  initialBrief,
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
  /** What to do, prefilled (the Board's `?brief=`, "Plan this"). */
  initialBrief?: string;
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
  const wide = useWide();
  const close = () => {
    if (busy) return;
    setStartedId(undefined);
    onOpenChange(false);
  };
  const body = planId ? (
    <IntakeView
      projectId={projectId}
      planId={planId}
      board={board}
      thumbNav={wide === false}
      onOpenCard={(number) => {
        setStartedId(undefined);
        onCreated(number);
      }}
      onClose={close}
    />
  ) : (
    <StartForm
      projectId={projectId}
      project={project}
      open={open}
      initialBrief={initialBrief}
      busy={busy}
      setBusy={setBusy}
      onCancel={wide === false ? undefined : () => onOpenChange(false)}
      onStarted={(id) => {
        setStartedId(id);
        onStarted?.(id);
      }}
    />
  );
  // Nothing until the width is known, so a phone never flashes the dialog.
  if (wide === undefined) return null;
  if (!wide) {
    return (
      <NewWorkScreen open={open} drafted={planId !== undefined} onClose={close}>
        {body}
      </NewWorkScreen>
    );
  }
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
        title="New work"
        description={describe(planId !== undefined)}
        className="sm:max-w-2xl"
      >
        {body}
      </DialogContent>
    </DialogRoot>
  );
}

const describe = (drafted: boolean) =>
  drafted
    ? 'The planner asks until the work is clear, then writes it in English — one card, or several if it splits. Close this to keep it as a draft.'
    : 'Say what to do, in any language — one task or several. The planner asks what it needs, then writes the cards.';

/**
 * New work on a phone (#678, stack S-6): a full-screen layer with the shared
 * phone back bar, whose Close sits in the thumb zone and above the soft
 * keyboard. The layer stays mounted while closed, so a brief that was typed
 * but not started is still there when it opens again; a started intake is
 * already a draft on the Board. Escape closes it, as the dialog does.
 */
export function NewWorkScreen({
  open,
  drafted,
  onClose,
  children,
}: {
  open: boolean;
  /** The intake exists on the server: the bar says the draft is saved. */
  drafted: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <FullScreenLayer {...newWorkLayer({ open, drafted, onClose })}>
      <NewWorkScreenBody drafted={drafted}>{children}</NewWorkScreenBody>
    </FullScreenLayer>
  );
}

/** The layer's props: Close (it has no parent screen), titled New work. */
export const newWorkLayer = ({
  open,
  drafted,
  onClose,
}: {
  open: boolean;
  drafted: boolean;
  onClose: () => void;
}) => ({
  label: 'New work',
  hidden: !open,
  onClose,
  bar: {
    title: 'New work',
    subtitle: drafted ? 'Draft saved' : undefined,
  },
});

/** The layer's scrolling page: the heading, what happens next, the step. */
export function NewWorkScreenBody({
  drafted,
  children,
}: {
  drafted: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-[max(env(safe-area-inset-top),16px)]">
      <h2 className="text-2xl font-semibold tracking-tight text-ink">
        New work
      </h2>
      <p className="mt-1.5 text-sm text-ink-2">{describe(drafted)}</p>
      <div className="mt-4 pb-4">{children}</div>
    </div>
  );
}

function StartForm({
  projectId,
  project,
  open,
  initialBrief,
  busy,
  setBusy,
  onCancel,
  onStarted,
}: {
  projectId: string;
  project?: ProjectDetail;
  open: boolean;
  initialBrief?: string;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  /** Absent on a phone, where the bar's Close is the way out. */
  onCancel?: () => void;
  onStarted: (planId: string) => void;
}) {
  const settings = useUserSettings(open);
  const [what, setWhat] = useState(initialBrief ?? '');
  // A prefilled brief arrives with the link that opens the dialog.
  useEffect(() => {
    if (open && initialBrief) setWhat(initialBrief);
  }, [open, initialBrief]);
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
        hint="In your own words and your own language — one task or several. No title: each card gets one."
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
          label="Attach files for the planner and the cards"
        />
      </section>
      <Field
        label="Model"
        htmlFor="board-new-model"
        hint="Your planning model from Account settings; this pick is for this request only."
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
        {onCancel ? (
          <Button variant="glass" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" disabled={!valid}>
          {busy ? 'Starting…' : 'Start'}
        </Button>
      </div>
    </form>
  );
}
