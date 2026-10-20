'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { Field, Input, Select } from '@andrewbehma/glass-ui/field';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { toast } from '@andrewbehma/glass-ui/toast';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import {
  AI_DIGEST_TIME_PATTERN,
  type AiDigestSettingsView,
} from '@nautelle/shared';
import Link from 'next/link';
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  fetchAiDigestSettings,
  saveAiDigestSettings,
} from '../../../../../lib/ai/actions';
import { describeError } from '../../../../../lib/api';
import { Time } from '../../../../../lib/format/time';
import {
  browserTimezone,
  timezoneOptions,
} from '../../../../../lib/schedules/format';
import { useErrorToast } from '../../../../../lib/section/use-error-toast';

type Form = Pick<AiDigestSettingsView, 'enabled' | 'time' | 'timezone'>;

/** A project that never saved the setting starts from the browser's zone. */
const formOf = (view: AiDigestSettingsView): Form => ({
  enabled: view.enabled,
  time: view.time,
  timezone: view.updatedAt === null ? browserTimezone() : view.timezone,
});

const same = (a: Form, b: AiDigestSettingsView): boolean =>
  a.enabled === b.enabled && a.time === b.time && a.timezone === b.timezone;

/**
 * #658: the daily AI digest — a switch, a time and the project's timezone.
 * Off by default. A project admin saves; everyone else reads.
 */
export function AiDigestTab({
  projectId,
  isAdmin,
}: {
  projectId: string;
  isAdmin: boolean;
}) {
  const [settings, setSettings] = useState<AiDigestSettingsView>();
  const [form, setForm] = useState<Form>();
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();
  const zones = useMemo(() => timezoneOptions(), []);

  const load = useCallback(async () => {
    try {
      const view = await fetchAiDigestSettings(projectId);
      setSettings(view);
      setForm(formOf(view));
    } catch (err) {
      showError(describeError(err));
    }
  }, [projectId, showError]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!settings || !form) return <Skeleton className="h-48 w-full" />;

  const patch = (change: Partial<Form>) =>
    setForm((prev) => (prev ? { ...prev, ...change } : prev));
  const locked = !isAdmin;
  const timeOk = AI_DIGEST_TIME_PATTERN.test(form.time);
  const dirty = !same(form, settings);
  const zoneOptions = zones.includes(form.timezone)
    ? zones
    : [form.timezone, ...zones];

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!timeOk) return;
    setBusy(true);
    try {
      const view = await saveAiDigestSettings(projectId, form);
      setSettings(view);
      setForm(formOf(view));
      toast.success(
        view.enabled
          ? `The digest arrives daily at ${view.time}, ${view.timezone}.`
          : 'The digest is off.',
      );
    } catch (err) {
      showError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card pad="lg">
      <form className="flex flex-col gap-6" onSubmit={save}>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-sm">
            {/* glass-ui's Toggle has no `disabled`: a locked one is inert and dimmed. */}
            <span
              aria-disabled={locked || undefined}
              inert={locked || undefined}
              className={locked ? 'opacity-60' : undefined}
            >
              <Toggle
                labelledBy="ai-digest-enabled"
                checked={form.enabled}
                onChange={(value) => {
                  if (isAdmin) patch({ enabled: value });
                }}
              />
            </span>
            <span id="ai-digest-enabled">Daily AI digest</span>
          </div>
          <p className="text-ink-3 text-xs">
            Once a day the project&rsquo;s AI model sums up the last day: what
            got done, what is stuck and what waits for a person, with links. It
            goes to every linked Telegram chat of the project&rsquo;s people and
            to{' '}
            <Link
              href={`/projects/${projectId}/activity`}
              className="text-accent-ink underline underline-offset-2"
            >
              Activity
            </Link>
            . Each digest is one call on the default model and counts toward its
            provider&rsquo;s monthly cap; when the cap is reached, the day is
            skipped.
          </p>
        </div>

        <fieldset
          className="grid gap-4 sm:grid-cols-2"
          disabled={locked || !form.enabled}
        >
          <legend className="sr-only">When</legend>
          <Field
            label="Time"
            htmlFor="ai-digest-time"
            hint="A change applies from the next day the time comes round."
          >
            <Input
              id="ai-digest-time"
              type="time"
              value={form.time}
              onChange={(e) => patch({ time: e.target.value })}
            />
          </Field>
          <Field label="Timezone" htmlFor="ai-digest-timezone">
            <Select
              id="ai-digest-timezone"
              value={form.timezone}
              onChange={(e) => patch({ timezone: e.target.value })}
            >
              {zoneOptions.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          </Field>
        </fieldset>

        {isAdmin && !timeOk ? (
          <p role="alert" className="text-danger text-xs">
            The time is HH:MM, 24-hour.
          </p>
        ) : null}

        {isAdmin ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-ink-3 text-xs">
              {settings.updatedAt ? (
                <>
                  Last changed <Time value={settings.updatedAt} />
                </>
              ) : (
                'Never changed — the digest is off.'
              )}
            </span>
            <Button
              variant="solid"
              type="submit"
              disabled={busy || !dirty || !timeOk}
            >
              Save
            </Button>
          </div>
        ) : (
          <p className="text-ink-3 text-sm">
            Only project administrators can change the digest.
          </p>
        )}
      </form>
    </Card>
  );
}
