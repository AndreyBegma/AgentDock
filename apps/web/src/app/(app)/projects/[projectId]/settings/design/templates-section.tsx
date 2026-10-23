'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Chip } from '@andrewbehma/glass-ui/chip';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { Field, Input, Textarea } from '@andrewbehma/glass-ui/field';
import { NumberInput } from '@andrewbehma/glass-ui/number-input';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { toast } from '@andrewbehma/glass-ui/toast';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import {
  DESIGN_FLOW_STEPS_MAX,
  DESIGN_FRAME_KIND_LABELS,
  type DesignTemplatesView,
  type DesignTemplateView,
} from '@nautelle/shared';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AsyncSection } from '../../../../../../components/prerequisites/async-section';
import { api } from '../../../../../../lib/api';
import { describeDesignError } from '../../../../../../lib/design/format';
import {
  addCustomFrame,
  blankDraft,
  draftOf,
  draftProblems,
  isBuiltinFrame,
  moveFrame,
  patchFrame,
  removeFrame,
  requestOf,
  type TemplateDraft,
} from '../../../../../../lib/design-templates/editor';
import { designTemplatesApi } from '../../../../../../lib/design-templates/href';
import { useErrorToast } from '../../../../../../lib/section/use-error-toast';
import { useSection } from '../../../../../../lib/section/use-section';

/**
 * Settings → Design → Templates (#833 D9, ADR-0082): the frames a design turn
 * draws. Every member reads them; a project admin changes a built-in's
 * optional frames, instructions and order, adds custom frames, resets a
 * built-in, and creates templates of the project's own.
 */
export function TemplatesSection({
  projectId,
  isAdmin,
}: {
  projectId: string;
  isAdmin: boolean;
}) {
  const section = useSection(
    () => api<DesignTemplatesView>(designTemplatesApi(projectId)),
    [projectId],
  );
  return (
    <AsyncSection
      section={section}
      unavailable={{
        title: 'The design templates could not be loaded',
        stillWorks: 'Designs keep following the saved templates.',
      }}
      empty={null}
    >
      {(data) => (
        <TemplateList
          projectId={projectId}
          isAdmin={isAdmin}
          templates={data.templates}
          onChanged={section.retry}
        />
      )}
    </AsyncSection>
  );
}

function TemplateList({
  projectId,
  isAdmin,
  templates,
  onChanged,
}: {
  projectId: string;
  isAdmin: boolean;
  templates: DesignTemplateView[];
  onChanged: () => void;
}) {
  // The key being edited, or a draft that is not saved yet.
  const [editing, setEditing] = useState<string | null>(null);
  const [fresh, setFresh] = useState<TemplateDraft | null>(null);
  const [newName, setNewName] = useState('');
  const taken = new Set(templates.map((t) => t.key));
  const created = newName.trim() ? blankDraft(newName) : null;
  const newProblem =
    created === null
      ? null
      : created.key === ''
        ? 'Use letters in the name.'
        : taken.has(created.key)
          ? `A template with the key ${created.key} exists.`
          : null;

  return (
    <section aria-labelledby="design-templates" className="flex flex-col gap-3">
      <SectionHeader
        headingId="design-templates"
        title="Templates"
        description={`The frames a design draws, in order. Optional frames can be turned off, and any template can get frames of its own.${
          isAdmin ? '' : ' Only a project admin can change them.'
        }`}
      />
      <ul className="flex flex-col gap-2">
        {templates.map((t) => (
          <li key={t.key} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{t.name}</span>
              <code className="text-xs text-ink-3">{t.key}</code>
              <Chip size="sm">{t.builtin ? 'Built-in' : 'Custom'}</Chip>
              {t.builtin && t.overridden ? (
                <Chip size="sm" tone="warn">
                  Customized
                </Chip>
              ) : null}
              <span className="text-xs text-ink-3">
                {t.frames.filter((f) => f.enabled).length} frames
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => setEditing(editing === t.key ? null : t.key)}
              >
                {editing === t.key ? 'Close' : isAdmin ? 'Edit' : 'View'}
              </Button>
            </div>
            {editing === t.key ? (
              <TemplateEditor
                projectId={projectId}
                isAdmin={isAdmin}
                template={t}
                initial={draftOf(t)}
                onDone={() => {
                  setEditing(null);
                  onChanged();
                }}
              />
            ) : null}
          </li>
        ))}
      </ul>
      {isAdmin ? (
        fresh ? (
          <TemplateEditor
            projectId={projectId}
            isAdmin
            template={null}
            initial={fresh}
            onCancel={() => setFresh(null)}
            onDone={() => {
              setFresh(null);
              setNewName('');
              onChanged();
            }}
          />
        ) : (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (created && !newProblem) setFresh(created);
            }}
          >
            <Field
              label="New template"
              hint="For example Landing page or Email."
              error={newProblem ?? undefined}
              htmlFor="new-template-name"
            >
              <Input
                id="new-template-name"
                className="w-64"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </Field>
            <Button
              type="submit"
              size="sm"
              variant="glass"
              disabled={!created || newProblem !== null}
            >
              New template
            </Button>
          </form>
        )
      ) : null}
    </section>
  );
}

function TemplateEditor({
  projectId,
  isAdmin,
  template,
  initial,
  onDone,
  onCancel,
}: {
  projectId: string;
  isAdmin: boolean;
  /** Null for a template that is not saved yet. */
  template: DesignTemplateView | null;
  initial: TemplateDraft;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [shown, setShown] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();
  const builtin = template?.builtin === true;
  const problems = draftProblems(draft);

  useEffect(() => setDraft(initial), [initial]);

  const setFrames = (frames: TemplateDraft['frames']) =>
    setDraft((d) => ({ ...d, frames }));

  const save = async () => {
    setShown(true);
    if (problems.length > 0) return;
    setBusy(true);
    try {
      await api(designTemplatesApi(projectId, draft.key), {
        method: 'PUT',
        body: requestOf(draft),
      });
      toast.success(`${draft.name} saved`);
      onDone();
    } catch (error) {
      showError(describeDesignError(error, projectId));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      await api(designTemplatesApi(projectId, draft.key), {
        method: 'DELETE',
      });
      toast.success(builtin ? `${draft.name} reset` : `${draft.name} deleted`);
      setConfirm(false);
      onDone();
    } catch (error) {
      showError(describeDesignError(error, projectId));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-4 rounded-card border border-line p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {builtin ? null : (
        <Field label="Template name" htmlFor={`tpl-${draft.key}-name`}>
          <Input
            id={`tpl-${draft.key}-name`}
            value={draft.name}
            disabled={!isAdmin}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
        </Field>
      )}
      <ol className="flex flex-col gap-3">
        {draft.frames.map((f, i) => {
          const own = isBuiltinFrame(draft.key, f.key);
          const id = `tpl-${draft.key}-${f.key}`;
          return (
            <li
              key={f.key}
              className="flex flex-col gap-2 border-b border-line pb-3 last:border-b-0"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-ink-3">{i + 1}</span>
                {isAdmin && !f.required ? (
                  <Toggle
                    labelledBy={`${id}-label`}
                    checked={f.enabled}
                    onChange={(enabled) =>
                      setFrames(patchFrame(draft.frames, f.key, { enabled }))
                    }
                  />
                ) : null}
                <span id={`${id}-label`} className="sr-only">
                  {`Draw ${f.name || `frame ${i + 1}`}`}
                </span>
                <Input
                  aria-label={`Frame ${i + 1} name`}
                  className="w-full sm:w-56"
                  value={f.name}
                  disabled={!isAdmin || own}
                  onChange={(e) =>
                    setFrames(
                      patchFrame(draft.frames, f.key, { name: e.target.value }),
                    )
                  }
                />
                <Chip size="sm">{DESIGN_FRAME_KIND_LABELS[f.kind]}</Chip>
                {f.required ? (
                  <Chip size="sm" tone="ok">
                    Required
                  </Chip>
                ) : null}
                {f.repeat ? (
                  <span className="flex items-center gap-1 text-xs text-ink-3">
                    Up to
                    <NumberInput
                      aria-label={`Frame ${i + 1} most repeats`}
                      className="w-20"
                      min={f.repeat.min}
                      max={DESIGN_FLOW_STEPS_MAX}
                      value={String(f.repeat.max)}
                      disabled={!isAdmin}
                      onChange={(e) =>
                        setFrames(
                          patchFrame(draft.frames, f.key, {
                            repeat: {
                              min: f.repeat?.min ?? 1,
                              max: Number(e.target.value) || f.repeat?.min || 1,
                            },
                          }),
                        )
                      }
                    />
                    steps
                  </span>
                ) : null}
                {isAdmin ? (
                  <span className="ml-auto flex gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      icon
                      aria-label={`Move ${f.name || `frame ${i + 1}`} up`}
                      disabled={i === 0}
                      onClick={() => setFrames(moveFrame(draft.frames, i, -1))}
                    >
                      <ArrowUp aria-hidden="true" className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      icon
                      aria-label={`Move ${f.name || `frame ${i + 1}`} down`}
                      disabled={i === draft.frames.length - 1}
                      onClick={() => setFrames(moveFrame(draft.frames, i, 1))}
                    >
                      <ArrowDown aria-hidden="true" className="size-4" />
                    </Button>
                    {own ? null : (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        icon
                        aria-label={`Remove ${f.name || `frame ${i + 1}`}`}
                        onClick={() =>
                          setFrames(removeFrame(draft.key, draft.frames, f.key))
                        }
                      >
                        <X aria-hidden="true" className="size-4" />
                      </Button>
                    )}
                  </span>
                ) : null}
              </div>
              <Textarea
                aria-label={`Frame ${i + 1} instruction`}
                rows={3}
                value={f.instruction}
                disabled={!isAdmin}
                placeholder="What to draw in this frame"
                onChange={(e) =>
                  setFrames(
                    patchFrame(draft.frames, f.key, {
                      instruction: e.target.value,
                    }),
                  )
                }
              />
            </li>
          );
        })}
      </ol>
      {isAdmin ? (
        <div>
          <Button
            type="button"
            size="sm"
            variant="glass"
            onClick={() => setFrames(addCustomFrame(draft.frames))}
          >
            Add custom frame
          </Button>
        </div>
      ) : null}
      {shown && problems.length > 0 ? (
        <ul role="alert" className="text-xs text-danger">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      {isAdmin ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="solid" disabled={busy}>
            {busy ? 'Saving…' : 'Save template'}
          </Button>
          {onCancel ? (
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          {template && (!builtin || template.overridden) ? (
            <Button
              type="button"
              variant="ghost"
              className="ml-auto"
              onClick={() => setConfirm(true)}
            >
              {builtin ? 'Reset to built-in' : 'Delete template'}
            </Button>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={builtin ? 'Reset to built-in?' : 'Delete this template?'}
        consequence={
          builtin
            ? `${draft.name} goes back to the frames it ships with. Designs already drawn keep theirs.`
            : `${draft.name} is removed. A card or task set to it draws a page instead.`
        }
        verb={builtin ? 'Reset' : 'Delete'}
        tone="danger"
        busy={busy}
        onConfirm={() => void reset()}
      />
    </form>
  );
}
