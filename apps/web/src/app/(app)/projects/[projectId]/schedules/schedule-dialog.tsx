'use client';

import type { SchedulePreviewView, ScheduleView } from '@agentdock/shared';
import { Banner } from 'glass-ui/banner';
import { Button } from 'glass-ui/button';
import { Combobox } from 'glass-ui/combobox';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { Field, Input, Select, Textarea } from 'glass-ui/field';
import {
  SegmentedControl,
  SegmentedControlItem,
} from 'glass-ui/segmented-control';
import { Toggle } from 'glass-ui/toggle';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../../../../lib/api';
import {
  browserTimezone,
  describeSchedulesError,
  emptyScheduleForm,
  formatFireTime,
  formFromSchedule,
  MISSED_POLICY_HINT,
  MISSED_POLICY_LABEL,
  SCHEDULE_FORM_PROBLEM_TEXT,
  SCHEDULE_MODELS,
  type ScheduleForm,
  scheduleFormProblem,
  timezoneOptions,
  toScheduleRequest,
} from '../../../../../lib/schedules/format';

const PREVIEW_DEBOUNCE_MS = 400;

export interface ProfileChoice {
  id: string;
  label: string;
}

type Preview =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ok'; view: SchedulePreviewView }
  | { state: 'error'; text: string };

/**
 * Creates or edits a schedule (spec 25 UI). The cron field is a plain `Input`
 * until glass-ui ships `CronInput` (D18): below it, the API's description and
 * the next five fire times in the chosen timezone. The API's 422 codes are
 * shown as sentences and the form stays open.
 */
export function ScheduleDialog({
  projectId,
  open,
  schedule,
  skills,
  profiles,
  onClose,
  onSaved,
}: {
  projectId: string;
  open: boolean;
  /** The schedule to edit; null creates a new one. */
  schedule: ScheduleView | null;
  /** Invocations of the project's runnable skills, for suggestions. */
  skills: string[];
  /** Runtime profiles the person may pick; empty = "Project default" only. */
  profiles: ProfileChoice[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<ScheduleForm>(() =>
    emptyScheduleForm(browserTimezone()),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<Preview>({ state: 'idle' });

  useEffect(() => {
    if (!open) return;
    setForm(
      schedule
        ? formFromSchedule(schedule)
        : emptyScheduleForm(browserTimezone()),
    );
    setError(undefined);
  }, [open, schedule]);

  const set = <K extends keyof ScheduleForm>(key: K, value: ScheduleForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const problem = scheduleFormProblem(form);
  const zones = useMemo(
    () => timezoneOptions().map((name) => ({ value: name, label: name })),
    [],
  );
  // An edited schedule may carry a name this browser does not list.
  const zoneOptions = useMemo(
    () =>
      zones.some((z) => z.value === form.timezone) || form.timezone === ''
        ? zones
        : [{ value: form.timezone, label: form.timezone }, ...zones],
    [zones, form.timezone],
  );

  // Preview only when the cheap checks pass, so typing does not spam the API.
  const cronReady =
    problem !== 'cron' && problem !== 'cron_fields' && problem !== 'timezone';
  const cron = form.cron.trim();
  const timezone = form.timezone.trim();
  useEffect(() => {
    if (!open || !cronReady) {
      setPreview({ state: 'idle' });
      return;
    }
    let cancelled = false;
    setPreview({ state: 'loading' });
    const timer = setTimeout(() => {
      api<SchedulePreviewView>('/schedules/preview', {
        method: 'POST',
        body: { cron, timezone },
      })
        .then((view) => {
          if (!cancelled) setPreview({ state: 'ok', view });
        })
        .catch((err) => {
          if (!cancelled) {
            setPreview({ state: 'error', text: describeSchedulesError(err) });
          }
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, cronReady, cron, timezone]);

  const close = () => {
    if (!busy) onClose();
  };

  const submit = async () => {
    if (problem) return;
    setBusy(true);
    setError(undefined);
    try {
      const body = toScheduleRequest(form);
      await api(
        schedule
          ? `/projects/${projectId}/schedules/${schedule.id}`
          : `/projects/${projectId}/schedules`,
        { method: schedule ? 'PATCH' : 'POST', body },
      );
      onSaved();
    } catch (err) {
      setError(describeSchedulesError(err));
    } finally {
      setBusy(false);
    }
  };

  const profileChoices =
    form.profileId && !profiles.some((p) => p.id === form.profileId)
      ? [...profiles, { id: form.profileId, label: form.profileId }]
      : profiles;

  return (
    <DialogRoot open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        title={schedule ? `Edit ${schedule.name}` : 'New schedule'}
        description="Runs a skill or the orchestrator on this project at fixed times, with your authority."
        footer={
          <>
            <Button variant="glass" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button disabled={busy || problem !== null} onClick={submit}>
              {busy ? 'Saving…' : schedule ? 'Save' : 'Create'}
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
          <Field label="Name" htmlFor="schedule-name" required>
            <Input
              id="schedule-name"
              value={form.name}
              maxLength={100}
              placeholder="e.g. Nightly security scan"
              autoFocus
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>

          <Field label="Runs">
            <SegmentedControl aria-label="Target">
              {(['skill', 'orchestrator'] as const).map((kind) => (
                <SegmentedControlItem
                  key={kind}
                  active={form.targetKind === kind}
                  layoutId="schedule-target-kind"
                >
                  <button
                    type="button"
                    aria-pressed={form.targetKind === kind}
                    className="relative w-full px-3 py-1.5 text-sm"
                    onClick={() => set('targetKind', kind)}
                  >
                    {kind === 'skill' ? 'A skill' : 'The orchestrator'}
                  </button>
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </Field>

          {form.targetKind === 'skill' ? (
            <>
              <Field
                label="Skill"
                htmlFor="schedule-skill"
                required
                hint="As it is invoked: name or plugin:name."
              >
                <Input
                  id="schedule-skill"
                  list="schedule-skills"
                  value={form.skill}
                  onChange={(e) => set('skill', e.target.value)}
                />
                <datalist id="schedule-skills">
                  {skills.map((skill) => (
                    <option key={skill} value={skill} />
                  ))}
                </datalist>
              </Field>
              <Field label="Arguments" htmlFor="schedule-args">
                <Textarea
                  id="schedule-args"
                  rows={3}
                  value={form.args}
                  onChange={(e) => set('args', e.target.value)}
                />
              </Field>
              <Field label="Runtime profile" htmlFor="schedule-profile">
                <Select
                  id="schedule-profile"
                  value={form.profileId}
                  onChange={(e) => set('profileId', e.target.value)}
                >
                  <option value="">Project default</option>
                  {profileChoices.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Model" htmlFor="schedule-model">
                <Input
                  id="schedule-model"
                  list="schedule-models"
                  value={form.model}
                  onChange={(e) => set('model', e.target.value)}
                />
                <datalist id="schedule-models">
                  {SCHEDULE_MODELS.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
              </Field>
              <Field label="Output" htmlFor="schedule-output">
                <Select
                  id="schedule-output"
                  value={form.output}
                  onChange={(e) =>
                    set('output', e.target.value === 'pr' ? 'pr' : 'report')
                  }
                >
                  <option value="report">Report — nothing is pushed</option>
                  <option value="pr">Pull request — changes go to a PR</option>
                </Select>
              </Field>
            </>
          ) : (
            <Field
              label="Orchestrator command"
              htmlFor="schedule-mode"
              hint="Uses the project’s orchestrator settings. If it is already running, the firing is a no-op."
            >
              <Select
                id="schedule-mode"
                value={form.mode}
                onChange={(e) =>
                  set('mode', e.target.value === 'start' ? 'start' : 'next')
                }
              >
                <option value="next">next — take the next queued issue</option>
                <option value="start">start — start the orchestrator</option>
              </Select>
            </Field>
          )}

          <Field
            label="Cron"
            htmlFor="schedule-cron"
            required
            hint="Five fields: minute hour day month weekday. At least 5 minutes apart."
          >
            <Input
              id="schedule-cron"
              className="font-mono"
              value={form.cron}
              spellCheck={false}
              onChange={(e) => set('cron', e.target.value)}
            />
          </Field>

          <Field label="Timezone" required>
            <Combobox
              aria-label="Timezone"
              options={zoneOptions}
              value={form.timezone || null}
              placeholder="Europe/Kyiv"
              onValueChange={(value) => set('timezone', value ?? '')}
            />
          </Field>

          <div aria-live="polite" className="text-sm">
            {preview.state === 'loading' ? (
              <span className="text-ink-3">Checking…</span>
            ) : null}
            {preview.state === 'error' ? (
              <p role="alert" className="text-danger">
                {preview.text}
              </p>
            ) : null}
            {preview.state === 'ok' ? (
              <div className="flex flex-col gap-1">
                <span className="font-medium">{preview.view.description}</span>
                <ul className="text-xs text-ink-2">
                  {preview.view.next.map((iso) => (
                    <li key={iso}>{formatFireTime(iso, timezone, true)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          <Field label="If a run is missed" htmlFor="schedule-missed">
            <Select
              id="schedule-missed"
              value={form.missedPolicy}
              onChange={(e) =>
                set(
                  'missedPolicy',
                  e.target.value === 'catch_up' ? 'catch_up' : 'skip',
                )
              }
            >
              {(['skip', 'catch_up'] as const).map((policy) => (
                <option key={policy} value={policy}>
                  {MISSED_POLICY_LABEL[policy]}
                </option>
              ))}
            </Select>
            <span className="text-xs text-ink-3">
              {MISSED_POLICY_HINT[form.missedPolicy]}
            </span>
          </Field>

          <div className="flex items-center justify-between gap-3">
            <span id="schedule-enabled-label" className="text-sm">
              Enabled
            </span>
            <Toggle
              checked={form.enabled}
              labelledBy="schedule-enabled-label"
              onChange={(value) => set('enabled', value)}
            />
          </div>

          {problem ? (
            <p className="text-xs text-ink-3">
              {SCHEDULE_FORM_PROBLEM_TEXT[problem]}
            </p>
          ) : null}
          {error ? (
            <Banner tone="danger" title="Not saved">
              {error}
            </Banner>
          ) : null}
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
