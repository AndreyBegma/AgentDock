'use client';

import {
  STEWARD_SILENCE_MINUTES_MAX,
  STEWARD_SILENCE_MINUTES_MIN,
  type StewardSettingsView,
} from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { Checkbox } from '@andrewbehma/glass-ui/checkbox';
import { Field, Input } from '@andrewbehma/glass-ui/field';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { toast } from '@andrewbehma/glass-ui/toast';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Time } from '../../../../../lib/format/time';
import { useErrorToast } from '../../../../../lib/section/use-error-toast';
import {
  fetchStewardSettings,
  saveStewardSettings,
} from '../../../../../lib/steward/actions';
import {
  describeStewardError,
  formOf,
  type StewardForm,
  sameForm,
  settingsOf,
} from '../../../../../lib/steward/format';

const ACTION_SWITCHES: readonly {
  key: 'autoNudge' | 'autoDismiss' | 'autoResume' | 'trailerGuard';
  label: string;
  hint: string;
}[] = [
  {
    key: 'autoNudge',
    label: 'Nudge after an API or network error',
    hint: 'Types one fixed line into the session, at most twice per round. A third error escalates.',
  },
  {
    key: 'autoDismiss',
    label: 'Dismiss known dialogs',
    hint: 'Only dialogs that need no decision. An unknown dialog or a permission prompt is never answered.',
  },
  {
    key: 'autoResume',
    label: 'Resume a dead card session',
    hint: 'Same worktree, at most twice per round, never a round a person stopped.',
  },
  {
    key: 'trailerGuard',
    label: 'Hold pushes with a Claude trailer',
    hint: 'A card push whose commits carry a Claude attribution trailer is withheld until the worker rewrites them.',
  },
];

/**
 * #447 D16: Steward's switch, its silence threshold, the digest time and one
 * switch per automatic action. A project admin saves; everyone else reads.
 * An action that is off is not performed — Steward escalates instead.
 */
export function StewardTab({
  projectId,
  isAdmin,
}: {
  projectId: string;
  isAdmin: boolean;
}) {
  const [settings, setSettings] = useState<StewardSettingsView>();
  const [form, setForm] = useState<StewardForm>();
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();

  const load = useCallback(async () => {
    try {
      const view = await fetchStewardSettings(projectId);
      setSettings(view);
      setForm(formOf(view));
    } catch (err) {
      showError(describeStewardError(err));
    }
  }, [projectId, showError]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!settings || !form) return <Skeleton className="h-64 w-full" />;

  const patch = (change: Partial<StewardForm>) =>
    setForm((prev) => (prev ? { ...prev, ...change } : prev));
  const dirty = !sameForm(form, formOf(settings));
  const parsed = settingsOf(form);
  const locked = !isAdmin;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!parsed.ok) {
      toast.error(parsed.message);
      return;
    }
    setBusy(true);
    try {
      const view = await saveStewardSettings(projectId, parsed.settings);
      setSettings(view);
      setForm(formOf(view));
      toast.success('Steward saved.');
    } catch (err) {
      showError(describeStewardError(err));
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
                labelledBy="steward-enabled"
                checked={form.enabled}
                onChange={(value) => {
                  if (isAdmin) patch({ enabled: value });
                }}
              />
            </span>
            <span id="steward-enabled">Steward</span>
          </div>
          <p className="text-ink-3 text-xs">
            Watches Board cards and runner runs for stuck work, fixes the safe
            cases itself, and tells you in one line when it needs a person.
            Fleet slots are only observed — never touched. Off means no
            incidents, no actions and no digest.{' '}
            <Link
              href="/activity?category=fleet"
              className="text-accent-ink underline underline-offset-2"
            >
              See incidents in Activity
            </Link>
            .
          </p>
        </div>

        <fieldset
          className="grid gap-4 sm:grid-cols-2"
          disabled={locked || !form.enabled}
        >
          <legend className="sr-only">Detection and digest</legend>
          <Field
            label="Silence threshold (minutes)"
            htmlFor="steward-silence"
            hint={`A round with no activity for this long is stuck. ${STEWARD_SILENCE_MINUTES_MIN}–${STEWARD_SILENCE_MINUTES_MAX}. A running background task never counts as silence.`}
          >
            <Input
              id="steward-silence"
              inputMode="numeric"
              value={form.silenceMinutes}
              onChange={(e) => patch({ silenceMinutes: e.target.value })}
            />
          </Field>
          <Field
            label="Digest time"
            htmlFor="steward-digest-time"
            hint="Once a day, in your time zone, to Telegram and Overview. Also sent when away mode is switched off."
          >
            <Input
              id="steward-digest-time"
              type="time"
              value={form.digestTime}
              onChange={(e) => patch({ digestTime: e.target.value })}
            />
          </Field>
        </fieldset>

        <fieldset
          className="flex flex-col gap-3"
          disabled={locked || !form.enabled}
        >
          <legend className="font-medium text-sm">Automatic actions</legend>
          <p className="text-ink-3 text-xs">
            An action that is off is not performed: Steward tells you instead.
          </p>
          <ul className="flex flex-col gap-3">
            {ACTION_SWITCHES.map(({ key, label, hint }) => (
              <li key={key}>
                <Checkbox
                  id={`steward-${key}`}
                  label={label}
                  hint={hint}
                  checked={form[key]}
                  onChange={(e) => patch({ [key]: e.target.checked })}
                />
              </li>
            ))}
          </ul>
        </fieldset>

        {isAdmin && dirty && !parsed.ok ? (
          <p role="alert" className="text-danger text-xs">
            {parsed.message}
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
                'Never changed — the defaults apply.'
              )}
            </span>
            <Button
              variant="solid"
              type="submit"
              disabled={busy || !dirty || !parsed.ok}
            >
              Save
            </Button>
          </div>
        ) : (
          <p className="text-ink-3 text-sm">
            Only project administrators can change Steward.
          </p>
        )}
      </form>
    </Card>
  );
}
