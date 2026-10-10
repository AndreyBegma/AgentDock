'use client';

import {
  DEFAULT_INBOUND_VALUE_PATTERN,
  type InboundTriggerView,
  type InboundTriggerWithSecret,
  type ProjectSummary,
} from '@agentdock/shared';
import { Banner } from 'glass-ui/banner';
import { Button } from 'glass-ui/button';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { Field, Input, Select, Textarea } from 'glass-ui/field';
import { useEffect, useState } from 'react';
import { api } from '../../../../lib/api';
import {
  describeWebhooksError,
  emptyTriggerForm,
  formFromTrigger,
  type TriggerForm,
  toTriggerCreateRequest,
  toTriggerUpdateRequest,
  triggerFormProblem,
} from '../../../../lib/webhooks/format';

/**
 * Creates or edits an inbound trigger (spec 26 UI). On create the response
 * carries the secret; it is handed to `onCreated` and nowhere else.
 */
export function TriggerDialog({
  open,
  trigger,
  projects,
  onClose,
  onCreated,
  onSaved,
}: {
  open: boolean;
  /** Set to edit; unset to create. */
  trigger?: InboundTriggerView;
  projects: ProjectSummary[];
  onClose: () => void;
  onCreated: (created: InboundTriggerWithSecret) => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<TriggerForm>(emptyTriggerForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setForm(trigger ? formFromTrigger(trigger) : emptyTriggerForm());
    setError(undefined);
  }, [open, trigger]);

  const creating = trigger === undefined;
  const problem = triggerFormProblem(form, creating);
  const set = <K extends keyof TriggerForm>(key: K, value: TriggerForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const close = () => {
    if (!busy) onClose();
  };

  const submit = async () => {
    if (problem) return;
    setBusy(true);
    setError(undefined);
    try {
      if (trigger) {
        const patch = toTriggerUpdateRequest(form, trigger);
        if (Object.keys(patch).length > 0) {
          await api(`/admin/triggers/${trigger.id}`, {
            method: 'PATCH',
            body: patch,
          });
        }
        onSaved();
      } else {
        onCreated(
          await api<InboundTriggerWithSecret>('/admin/triggers', {
            method: 'POST',
            body: toTriggerCreateRequest(form),
          }),
        );
      }
    } catch (err) {
      setError(describeWebhooksError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogRoot open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        title={trigger ? 'Edit trigger' : 'New trigger'}
        description="A signed POST starts one skill run, or orchestrator next, on a project. The payload only fills the placeholders you allow."
        footer={
          <>
            <Button variant="glass" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button disabled={busy || problem !== null} onClick={submit}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Field label="Name" htmlFor="trigger-name" required>
            <Input
              id="trigger-name"
              value={form.name}
              maxLength={100}
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>
          <Field
            label="Project"
            htmlFor="trigger-project"
            required
            hint={creating ? undefined : 'The project is fixed at create.'}
          >
            <Select
              id="trigger-project"
              value={form.projectId}
              disabled={!creating}
              onChange={(e) => set('projectId', e.target.value)}
            >
              <option value="">Pick a project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Action" htmlFor="trigger-kind">
            <Select
              id="trigger-kind"
              value={form.kind}
              onChange={(e) =>
                set(
                  'kind',
                  e.target.value === 'orchestrator' ? 'orchestrator' : 'skill',
                )
              }
            >
              <option value="skill">Run a skill</option>
              <option value="orchestrator">Orchestrator next</option>
            </Select>
          </Field>

          {form.kind === 'skill' ? (
            <>
              <Field
                label="Skill"
                htmlFor="trigger-skill"
                required
                hint="<name> or <plugin>:<name>, e.g. code-sentinel:debug"
              >
                <Input
                  id="trigger-skill"
                  value={form.skill}
                  onChange={(e) => set('skill', e.target.value)}
                />
              </Field>
              <Field
                label="Args"
                htmlFor="trigger-args"
                hint="Text and {{payload.some.path}} placeholders only — nothing else is interpreted, and nothing reaches a shell."
              >
                <Textarea
                  id="trigger-args"
                  rows={3}
                  className="font-mono"
                  value={form.args}
                  onChange={(e) => set('args', e.target.value)}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Output" htmlFor="trigger-output">
                  <Select
                    id="trigger-output"
                    value={form.output}
                    onChange={(e) =>
                      set('output', e.target.value === 'pr' ? 'pr' : 'report')
                    }
                  >
                    <option value="report">Report</option>
                    <option value="pr">Pull request</option>
                  </Select>
                </Field>
                <Field
                  label="Profile"
                  htmlFor="trigger-profile"
                  hint="Optional"
                >
                  <Input
                    id="trigger-profile"
                    value={form.profileKey}
                    onChange={(e) => set('profileKey', e.target.value)}
                  />
                </Field>
                <Field label="Model" htmlFor="trigger-model" hint="Optional">
                  <Input
                    id="trigger-model"
                    value={form.model}
                    onChange={(e) => set('model', e.target.value)}
                  />
                </Field>
              </div>
            </>
          ) : null}

          <Field
            label="Allowed paths"
            htmlFor="trigger-paths"
            hint="One payload path per line, e.g. run.id. A placeholder outside this list is refused."
          >
            <Textarea
              id="trigger-paths"
              rows={3}
              className="font-mono"
              value={form.allowedPaths}
              onChange={(e) => set('allowedPaths', e.target.value)}
            />
          </Field>
          <Field
            label="Value pattern"
            htmlFor="trigger-pattern"
            hint={`Every rendered value must match. Empty = ${DEFAULT_INBOUND_VALUE_PATTERN}`}
          >
            <Input
              id="trigger-pattern"
              className="font-mono"
              value={form.valuePattern}
              onChange={(e) => set('valuePattern', e.target.value)}
            />
          </Field>
          {problem && form.name.trim() !== '' ? (
            <p className="text-xs text-ink-3" role="status">
              {problem}
            </p>
          ) : null}
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
