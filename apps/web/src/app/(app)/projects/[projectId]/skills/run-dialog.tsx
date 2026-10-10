'use client';

import type { InstalledSkillView, SkillRunView } from '@agentdock/shared';
import { Banner } from 'glass-ui/banner';
import { Button } from 'glass-ui/button';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { Field, Input, Select, Textarea } from 'glass-ui/field';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '../../../../../lib/api';
import { describeBudgetExceededError } from '../../../../../lib/budgets/format';
import {
  PERMISSION_MODE_LABEL,
  permissionModesFor,
} from '../../../../../lib/control/format';
import {
  describeSkillsError,
  EMPTY_RUN_FORM,
  permissionWarning,
  RUN_FORM_PROBLEM_TEXT,
  type RunForm,
  runFormProblem,
  SKILL_MODELS,
  SKILL_OUTPUT_LABEL,
  toRunRequest,
  utf8Bytes,
} from '../../../../../lib/skills/format';

/**
 * Starts a skill run (spec 24 UI). The API refuses `not_runnable`, a codex
 * profile and `bypassPermissions` without admin before anything is sent;
 * those refusals are shown as sentences, the form stays open.
 */
export function RunDialog({
  projectId,
  skill,
  profileKeys,
  isAdmin,
  onOpenChange,
}: {
  projectId: string;
  skill: InstalledSkillView | null;
  /** Profiles the person can pick; empty = "Project default" only. */
  profileKeys: string[];
  isAdmin: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [form, setForm] = useState<RunForm>(EMPTY_RUN_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** Set when the start was refused by a stop budget (409 `budget_exceeded`). */
  const [budgetRefusal, setBudgetRefusal] = useState<string>();

  const problem = runFormProblem(form);
  const warning = permissionWarning(form.permissionMode);
  const set = <K extends keyof RunForm>(key: K, value: RunForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const close = () => {
    if (busy) return;
    setForm(EMPTY_RUN_FORM);
    setError(undefined);
    setBudgetRefusal(undefined);
    onOpenChange(false);
  };

  const submit = async () => {
    if (!skill || problem) return;
    setBusy(true);
    setError(undefined);
    setBudgetRefusal(undefined);
    try {
      const run = await api<SkillRunView>(`/projects/${projectId}/skill-runs`, {
        method: 'POST',
        body: toRunRequest(skill.invocation, form),
      });
      setForm(EMPTY_RUN_FORM);
      onOpenChange(false);
      router.push(`/projects/${projectId}/skills/runs/${run.runId}`);
    } catch (err) {
      setBudgetRefusal(describeBudgetExceededError(err) ?? undefined);
      setError(describeSkillsError(err));
    } finally {
      setBusy(false);
    }
  };

  const modes = permissionModesFor(isAdmin);

  return (
    <DialogRoot open={skill !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent
        title={skill ? `Run ${skill.invocation}` : 'Run skill'}
        description={
          skill?.description ??
          'Runs headless in its own worktree and ends as a report or a pull request.'
        }
        footer={
          <>
            <Button variant="glass" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button disabled={busy || problem !== null} onClick={submit}>
              {busy ? 'Starting…' : 'Run'}
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
          <Field
            label="Arguments"
            htmlFor="skill-run-args"
            hint="Sent after the skill name: /skill <arguments>."
          >
            <Textarea
              id="skill-run-args"
              rows={4}
              value={form.args}
              placeholder={skill?.argumentHint ?? ''}
              onChange={(e) => set('args', e.target.value)}
            />
          </Field>
          <Field
            label="Runtime profile"
            htmlFor="skill-run-profile"
            hint="Only Claude profiles can run skills."
          >
            <Select
              id="skill-run-profile"
              value={form.profileKey}
              onChange={(e) => set('profileKey', e.target.value)}
            >
              <option value="">Project default</option>
              {profileKeys.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Model" htmlFor="skill-run-model">
            <Input
              id="skill-run-model"
              list="skill-run-models"
              value={form.model}
              onChange={(e) => set('model', e.target.value)}
            />
            <datalist id="skill-run-models">
              {SKILL_MODELS.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </Field>
          <Field label="Output" htmlFor="skill-run-output">
            <Select
              id="skill-run-output"
              value={form.output}
              onChange={(e) =>
                set('output', e.target.value === 'pr' ? 'pr' : 'report')
              }
            >
              {(['report', 'pr'] as const).map((output) => (
                <option key={output} value={output}>
                  {SKILL_OUTPUT_LABEL[output]}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Permission mode"
            htmlFor="skill-run-mode"
            hint="Empty = the project’s orchestrator setting."
          >
            <Select
              id="skill-run-mode"
              value={form.permissionMode}
              onChange={(e) =>
                set(
                  'permissionMode',
                  modes.find((mode) => mode === e.target.value) ?? '',
                )
              }
            >
              <option value="">Project default</option>
              {modes.map((mode) => (
                <option key={mode} value={mode}>
                  {PERMISSION_MODE_LABEL[mode]}
                </option>
              ))}
            </Select>
          </Field>
          {warning ? (
            <Banner tone="warn" title="Not the default permission mode">
              {warning}
            </Banner>
          ) : null}
          <Field
            label="Timeout (minutes)"
            htmlFor="skill-run-timeout"
            hint="Empty = the runner’s default (60). At most 360."
          >
            <Input
              id="skill-run-timeout"
              inputMode="numeric"
              value={form.timeoutMinutes}
              onChange={(e) => set('timeoutMinutes', e.target.value)}
            />
          </Field>
          {problem ? (
            <p role="alert" className="text-sm text-danger">
              {problem === 'args_too_long'
                ? `${RUN_FORM_PROBLEM_TEXT[problem]} (${utf8Bytes(form.args)} bytes)`
                : RUN_FORM_PROBLEM_TEXT[problem]}
            </p>
          ) : null}
          {budgetRefusal ? (
            <Banner tone="danger" title="Budget used up">
              {budgetRefusal}
            </Banner>
          ) : error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
