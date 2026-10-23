'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { SheetRoot } from '@andrewbehma/glass-ui/sheet';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import { useBreakpoint } from '@andrewbehma/glass-ui/use-breakpoint';
import {
  REVIEW_FIX_ROUNDS_MAX,
  type ReviewSettingsView,
  type ReviewStepView,
} from '@nautelle/shared';
import { Plus } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { ConfirmGate } from '../../../../../components/confirm/confirm-gate';
import { AddStepForm } from '../../../../../components/review/add-step-form';
import { PeerReviewEditor } from '../../../../../components/review/peer-review-editor';
import { ReviewStepList } from '../../../../../components/review/review-step-list';
import {
  createReviewStep,
  deleteReviewStep,
  fetchReview,
  fetchReviewSkills,
  regeneratePeerReview,
  reorderReviewSteps,
  updateReview,
  updateReviewStep,
} from '../../../../../lib/review/actions';
import {
  describeReviewError,
  generationErrorText,
  inOrder,
  moveId,
  newStepRequest,
  REGENERATE_COPY,
  REVIEW_MASTER_HINT,
  REVIEW_MASTER_LABEL,
  REVIEW_PUBLISH_HINT,
  REVIEW_PUBLISH_LABEL,
  skillOptions,
} from '../../../../../lib/review/format';

/** A switch with its label and a one-line explanation; locked ones are inert and dimmed. */
function SwitchRow({
  id,
  checked,
  disabled,
  label,
  hint,
  onChange,
}: {
  id: string;
  checked: boolean;
  disabled: boolean;
  label: string;
  hint: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <span
        aria-disabled={disabled || undefined}
        inert={disabled || undefined}
        className={disabled ? 'pt-0.5 opacity-60' : 'pt-0.5'}
      >
        <Toggle
          labelledBy={id}
          checked={checked}
          onChange={(value) => {
            if (!disabled) onChange(value);
          }}
        />
      </span>
      <div className="flex flex-col gap-1">
        <span id={id} className="font-medium text-sm">
          {label}
        </span>
        <span className="text-ink-2 text-xs">{hint}</span>
      </div>
    </div>
  );
}

const peerOf = (view: ReviewSettingsView): ReviewStepView | undefined =>
  view.steps.find((step) => step.type === 'peer_review');

/**
 * Review steps of the project (#890, ADR-0084): the master switch, the PR
 * comments switch, the ordered steps, and the Peer review instructions. A
 * project admin edits; everyone else reads. Talks to the API over HTTP only.
 */
export function ReviewTab({
  projectId,
  isAdmin,
}: {
  projectId: string;
  isAdmin: boolean;
}) {
  const phone = useBreakpoint() === 'phone';
  const [view, setView] = useState<ReviewSettingsView>();
  const [loadError, setLoadError] = useState<string>();
  // A refusal of the last change, shown above the list; cleared by the next one.
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [addName, setAddName] = useState('');
  const [addSkill, setAddSkill] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [skills, setSkills] = useState<{ value: string; label: string }[]>([]);
  const [skillsError, setSkillsError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [editorError, setEditorError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState<true>();

  const load = useCallback(async () => {
    try {
      setView(await fetchReview(projectId));
      setLoadError(undefined);
    } catch (err) {
      setLoadError(describeReviewError(err));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadError && !view) {
    return (
      <Banner tone="danger">
        {loadError}{' '}
        <Button variant="link" onClick={() => void load()}>
          Try again
        </Button>
      </Banner>
    );
  }
  if (!view) return <Skeleton className="h-64 w-full" />;

  const peer = peerOf(view);
  const disabled = !isAdmin;

  /** Runs one write; a refusal lands inline, never as a toast. */
  const write = async (
    work: () => Promise<void>,
    fail: (message: string) => void = setError,
  ) => {
    setBusy(true);
    fail('');
    try {
      await work();
    } catch (err) {
      fail(describeReviewError(err));
    } finally {
      setBusy(false);
    }
  };
  const replaceStep = (next: ReviewStepView) =>
    setView((cur) =>
      cur
        ? {
            ...cur,
            steps: cur.steps.map((s) => (s.id === next.id ? next : s)),
          }
        : cur,
    );

  const changeSettings = (body: {
    reviewEnabled?: boolean;
    publishReviewComments?: boolean;
  }) =>
    write(async () => {
      setNotice(null);
      // Turning review on the first time makes a model write the instructions.
      setEnabling(body.reviewEnabled === true && !peer);
      try {
        const { generationError, ...next } = await updateReview(
          projectId,
          body,
        );
        setView(next);
        if (generationError) setNotice(generationErrorText(generationError));
      } finally {
        setEnabling(false);
      }
    });

  const toggleStep = (step: ReviewStepView, enabled: boolean) =>
    write(async () =>
      replaceStep(await updateReviewStep(projectId, step.id, { enabled })),
    );

  const moveStep = (stepId: string, to: number) => {
    setDragging(null);
    const ids = view.steps.map((s) => s.id);
    const next = moveId(ids, ids.indexOf(stepId), to);
    if (next.join() === ids.join()) return;
    const before = view;
    setView({ ...view, steps: inOrder(view.steps, next) });
    void write(async () => {
      try {
        const steps = await reorderReviewSteps(projectId, { stepIds: next });
        setView((cur) => (cur ? { ...cur, steps } : cur));
      } catch (err) {
        setView(before);
        throw err;
      }
    });
  };

  const removeStep = (step: ReviewStepView) =>
    write(async () => {
      await deleteReviewStep(projectId, step.id);
      setView((cur) =>
        cur
          ? { ...cur, steps: cur.steps.filter((s) => s.id !== step.id) }
          : cur,
      );
    });

  const openAdd = () => {
    setAdding(true);
    setAddError(null);
    if (skills.length > 0) return;
    fetchReviewSkills(projectId)
      .then((inventory) => {
        setSkills(skillOptions(inventory.items));
        setSkillsError(null);
      })
      .catch((err) => setSkillsError(describeReviewError(err)));
  };

  const addStep = () => {
    const request = newStepRequest(addName, addSkill);
    if (!request) return;
    void write(async () => {
      const step = await createReviewStep(projectId, request);
      setView((cur) => (cur ? { ...cur, steps: [...cur.steps, step] } : cur));
      setAdding(false);
      setAddName('');
      setAddSkill(null);
    }, setAddError);
  };

  const openEditor = () => {
    setDraft(peer?.instructions ?? '');
    setEditorError(null);
    setEditing(true);
  };

  const saveInstructions = async () => {
    if (!peer) return;
    setSaving(true);
    setEditorError(null);
    try {
      replaceStep(
        await updateReviewStep(projectId, peer.id, { instructions: draft }),
      );
    } catch (err) {
      setEditorError(describeReviewError(err));
    } finally {
      setSaving(false);
    }
  };

  // Called only after the person confirmed: the answer replaces the text.
  const regenerate = async () => {
    setConfirmRegenerate(undefined);
    setGenerating(true);
    setEditorError(null);
    setError(null);
    try {
      const next = await regeneratePeerReview(projectId);
      replaceStep(next);
      setDraft(next.instructions ?? '');
    } catch (err) {
      const message = describeReviewError(err);
      if (editing) setEditorError(message);
      else setError(message);
    } finally {
      setGenerating(false);
    }
  };

  let steps: ReactNode;
  if (view.steps.length === 0) {
    steps = (
      <p className="p-4 text-ink-2 text-sm">
        No steps yet. Turning review on creates the built-in Peer review step.
      </p>
    );
  } else {
    steps = (
      <ReviewStepList
        steps={view.steps}
        disabled={disabled}
        busy={busy || generating}
        dragging={dragging}
        onDragStart={setDragging}
        onMove={moveStep}
        onToggle={(step, enabled) => void toggleStep(step, enabled)}
        onEdit={() => openEditor()}
        onRegenerate={() => setConfirmRegenerate(true)}
        onDelete={(step) => void removeStep(step)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card pad="lg">
        <div className="flex flex-col gap-4">
          <SwitchRow
            id="review-master"
            checked={view.reviewEnabled}
            disabled={disabled || busy || enabling}
            label={REVIEW_MASTER_LABEL}
            hint={REVIEW_MASTER_HINT}
            onChange={(value) => void changeSettings({ reviewEnabled: value })}
          />
          <SwitchRow
            id="review-publish"
            checked={view.publishReviewComments}
            disabled={disabled || busy}
            label={REVIEW_PUBLISH_LABEL}
            hint={REVIEW_PUBLISH_HINT}
            onChange={(value) =>
              void changeSettings({ publishReviewComments: value })
            }
          />
          {enabling ? (
            <p role="status" className="text-ink-2 text-sm">
              Turning review on and generating the Peer review instructions from
              the repository. This can take a minute.
            </p>
          ) : null}
          {disabled ? (
            <p className="text-ink-3 text-sm">
              Only project administrators can change review settings.
            </p>
          ) : null}
        </div>
      </Card>

      {error ? <Banner tone="danger">{error}</Banner> : null}
      {notice ? <Banner tone="warn">{notice}</Banner> : null}

      <Card pad="none">
        <div className="flex items-start justify-between gap-3 p-4">
          <div>
            <h3 className="font-semibold text-base">Review steps</h3>
            <p className="text-ink-2 text-sm">
              Run in this order after a card’s CI is green. Blocking findings
              get up to {REVIEW_FIX_ROUNDS_MAX} fix rounds per PR.
            </p>
          </div>
          {!disabled && !adding ? (
            <Button variant="glass" size="sm" onClick={openAdd}>
              <Plus aria-hidden="true" className="size-4" />
              Add step
            </Button>
          ) : null}
        </div>
        {steps}
        {adding ? (
          <AddStepForm
            name={addName}
            skill={addSkill}
            options={skills}
            skillsError={skillsError}
            busy={busy}
            error={addError || null}
            onName={setAddName}
            onSkill={(skill) => {
              setAddSkill(skill);
              if (skill && !addName.trim()) setAddName(skill);
            }}
            onAdd={addStep}
            onCancel={() => setAdding(false)}
          />
        ) : null}
      </Card>

      <SheetRoot open={editing} onOpenChange={setEditing}>
        {editing ? (
          <PeerReviewEditor
            value={draft}
            saved={peer?.instructions ?? ''}
            phone={phone}
            readOnly={disabled}
            generating={generating}
            saving={saving}
            error={editorError}
            onChange={setDraft}
            onSave={() => void saveInstructions()}
            onRegenerate={() => setConfirmRegenerate(true)}
          />
        ) : null}
      </SheetRoot>

      <ConfirmGate
        pending={confirmRegenerate}
        copy={() => ({ ...REGENERATE_COPY })}
        onConfirm={() => void regenerate()}
        onCancel={() => setConfirmRegenerate(undefined)}
      />
    </div>
  );
}
