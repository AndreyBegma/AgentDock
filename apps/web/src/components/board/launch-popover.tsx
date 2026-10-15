'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Field, Select } from '@andrewbehma/glass-ui/field';
import {
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
} from '@andrewbehma/glass-ui/popover';
import { type ReactNode, useState } from 'react';
import {
  DEFAULT_VALUE,
  type LaunchCard,
  type LaunchForm,
  type LaunchKind,
  launchDefaults,
  launchModelOptions,
  launchRequest,
  profileKeysWith,
  recommendationNote,
} from '../../lib/board/launch';
import { useLaunchProfiles } from '../../lib/board/use-launch-profiles';
import {
  defaultProfileOptionLabel,
  profileOptionLabel,
} from '../../lib/skills/format';

export type LaunchRequest = ReturnType<typeof launchRequest>;

/**
 * #322 D1: the button of Run, Run again, Generate and Revise on a card. It
 * opens a small popover — Claude profile, model, and the action — whose
 * defaults start the work as it always started: one click on the action.
 * Nothing in it waits for a recommendation (D7); the line under the model
 * says so when there is none.
 */
export function LaunchPopover({
  projectId,
  card,
  kind,
  label,
  actionLabel = label,
  variant = 'solid',
  disabled = false,
  describedBy,
  title,
  onLaunch,
}: {
  projectId: string;
  card: LaunchCard;
  kind: LaunchKind;
  /** The trigger's text. */
  label: ReactNode;
  /** The popover's own action button; defaults to the trigger's text. */
  actionLabel?: ReactNode;
  variant?: 'solid' | 'glass';
  disabled?: boolean;
  describedBy?: string;
  title?: string;
  /** Starts the work; a refusal is toasted by the caller and rethrown. */
  onLaunch: (request: LaunchRequest) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={variant}
          disabled={disabled}
          title={title}
          aria-describedby={describedBy}
        >
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        title={kind === 'work' ? 'Run with' : 'Design with'}
        align="start"
      >
        <LaunchFields
          projectId={projectId}
          card={card}
          kind={kind}
          actionLabel={actionLabel}
          onLaunch={async (request) => {
            await onLaunch(request);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </PopoverRoot>
  );
}

/** Mounted only while the popover is open, so the profiles load on demand. */
function LaunchFields({
  projectId,
  card,
  kind,
  actionLabel,
  onLaunch,
}: {
  projectId: string;
  card: LaunchCard;
  kind: LaunchKind;
  actionLabel: ReactNode;
  onLaunch: (request: LaunchRequest) => Promise<unknown>;
}) {
  const [form, setForm] = useState<LaunchForm>(() =>
    launchDefaults(card, kind),
  );
  const [busy, setBusy] = useState(false);
  const profiles = useLaunchProfiles(projectId, true);
  const list = profiles.data ?? [];
  const byKey = new Map(list.map((p) => [p.key, p]));
  const models = launchModelOptions(card, kind);
  const idPrefix = `launch-${kind}`;

  const start = async () => {
    setBusy(true);
    try {
      await onLaunch(launchRequest(form));
    } catch {
      // Toasted by the caller; the popover stays so the choice is kept.
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <Field
        label="Claude profile"
        htmlFor={`${idPrefix}-profile`}
        hint={
          profiles.error
            ? 'The runner’s profiles could not be loaded; the default is used.'
            : undefined
        }
      >
        <Select
          id={`${idPrefix}-profile`}
          value={form.profileKey}
          onChange={(e) =>
            setForm((current) => ({ ...current, profileKey: e.target.value }))
          }
        >
          <option value={DEFAULT_VALUE}>
            {defaultProfileOptionLabel(list)}
          </option>
          {profileKeysWith(list, form.profileKey).map((key) => {
            const profile = byKey.get(key);
            return (
              <option key={key} value={key}>
                {profile ? profileOptionLabel(profile) : key}
              </option>
            );
          })}
        </Select>
      </Field>
      <Field
        label="Model"
        htmlFor={`${idPrefix}-model`}
        hint={recommendationNote(card, kind)}
      >
        <Select
          id={`${idPrefix}-model`}
          value={form.model}
          onChange={(e) =>
            setForm((current) => ({ ...current, model: e.target.value }))
          }
        >
          {models.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex justify-end">
        <Button variant="solid" type="submit" disabled={busy}>
          {busy ? 'Starting…' : actionLabel}
        </Button>
      </div>
    </form>
  );
}
