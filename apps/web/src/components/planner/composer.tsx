'use client';

import type {
  CreatePlanRequest,
  PlanMode,
  ProjectRuntimeProfile,
} from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { Field, Select, Textarea } from '@andrewbehma/glass-ui/field';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@andrewbehma/glass-ui/segmented-control';
import { useState } from 'react';
import {
  initialProfileKey,
  planProfileReason,
} from '../../lib/planner/profile';
import { profileOptionLabel, SKILL_MODELS } from '../../lib/skills/format';
import { DisabledReason } from '../prerequisites/disabled-reason';

const MODES: { value: PlanMode; label: string; hint: string }[] = [
  {
    value: 'batch',
    label: 'Batch',
    hint: 'The planner splits the brief into tasks straight away.',
  },
  {
    value: 'dialogue',
    label: 'Dialogue',
    hint: 'The planner asks about the brief first, then splits it.',
  },
];

/** D14: opus unless the person picks another. */
const DEFAULT_MODEL = 'opus';

/**
 * The brief composer (spec 172 UI): a large text box, the mode, and the
 * model and runtime profile every turn of the plan will use. **Plan** is the
 * page's one solid action. The profile starts on the project default or the
 * only one (#213); with none to use, Plan says why and links to the fix
 * instead of letting the API answer 422. Below `md` the model, the profile
 * and Plan stick to the bottom of the screen while the brief scrolls.
 */
export function Composer({
  projectId,
  initialBrief,
  profiles,
  disabledReason,
  onCreate,
}: {
  projectId: string;
  /** `?brief=` from the Fleet canvas's "Plan this" (#160). */
  initialBrief: string;
  /**
   * The runner's Claude profiles; `undefined` while they load, `'failed'`
   * when they could not be read.
   */
  profiles: readonly ProjectRuntimeProfile[] | 'failed' | undefined;
  /** Why the person cannot start a plan (a viewer); null when they can. */
  disabledReason: string | null;
  /** Rejects to keep the form as it is. */
  onCreate: (request: CreatePlanRequest) => Promise<void>;
}) {
  const [brief, setBrief] = useState(initialBrief);
  const [mode, setMode] = useState<PlanMode>('batch');
  const [model, setModel] = useState(DEFAULT_MODEL);
  // The person's pick; until then the preselection follows the loaded list.
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const list = Array.isArray(profiles) ? profiles : [];
  const profileKey = picked ?? initialProfileKey(list);
  const profileReason =
    disabledReason === null && profiles !== undefined
      ? planProfileReason(profileKey, profiles, projectId)
      : null;
  const off = busy || disabledReason !== null;
  const cannotPlan =
    off ||
    profiles === undefined ||
    profileReason !== null ||
    brief.trim() === '';

  const submit = async () => {
    const text = brief.trim();
    if (!text || cannotPlan) return;
    setBusy(true);
    try {
      await onCreate({
        brief: text,
        mode,
        ...(model !== DEFAULT_MODEL ? { model } : {}),
        profileKey,
      });
    } catch {
      // The caller said why; the brief stays.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card variant="content" pad="md">
      <form
        className="flex min-w-0 flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field
          label="Brief"
          htmlFor="planner-brief"
          hint="What should be built or fixed, in your own words. The planner reads the code and splits it into bugs and features."
        >
          <Textarea
            id="planner-brief"
            rows={7}
            value={brief}
            disabled={off}
            onChange={(e) => setBrief(e.target.value)}
          />
        </Field>
        <fieldset className="flex min-w-0 flex-col gap-1">
          <legend className="mb-1 text-xs font-medium text-ink-2">Mode</legend>
          <SegmentedControl
            aria-label="Mode"
            variant="on-glass"
            className="self-start"
          >
            {MODES.map((m) => (
              <SegmentedControlItem
                key={m.value}
                active={mode === m.value}
                layoutId="planner-mode"
              >
                <button
                  type="button"
                  aria-pressed={mode === m.value}
                  disabled={off}
                  onClick={() => setMode(m.value)}
                  className="relative w-full px-4 py-1.5 text-sm font-medium"
                >
                  {m.label}
                </button>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
          <span className="text-xs text-ink-3">
            {MODES.find((m) => m.value === mode)?.hint}
          </span>
        </fieldset>
        {/* The sticky footer below `md`: the TabBar floats over the last
            6 rem of a phone screen, so it sits just above it. */}
        <div className="sticky bottom-24 z-10 -mx-4 flex flex-col gap-3 border-t border-line bg-content px-4 py-3 md:static md:mx-0 md:border-0 md:bg-transparent md:p-0">
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-3 md:grid-cols-[minmax(0,12rem)_minmax(0,16rem)_1fr]">
            <Field label="Model" htmlFor="planner-model">
              <Select
                id="planner-model"
                value={model}
                disabled={off}
                onChange={(e) => setModel(e.target.value)}
              >
                {SKILL_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Runtime profile" htmlFor="planner-profile">
              <Select
                id="planner-profile"
                value={profileKey}
                disabled={off || list.length === 0}
                aria-describedby={
                  profileReason ? 'planner-profile-reason' : undefined
                }
                onChange={(e) => setPicked(e.target.value)}
              >
                {profiles === undefined ? (
                  <option value="">Loading…</option>
                ) : profileKey === '' ? (
                  <option value="" disabled>
                    {list.length === 0
                      ? 'None on the runner'
                      : 'Pick a profile'}
                  </option>
                ) : null}
                {list.map((p) => (
                  <option key={p.key} value={p.key}>
                    {profileOptionLabel(p)}
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              type="submit"
              className="justify-self-end"
              disabled={cannotPlan}
              aria-describedby={
                profileReason ? 'planner-profile-reason' : undefined
              }
            >
              {busy ? 'Starting…' : 'Plan'}
            </Button>
          </div>
          {disabledReason ? (
            <DisabledReason>{disabledReason}</DisabledReason>
          ) : profileReason ? (
            <DisabledReason
              id="planner-profile-reason"
              href={profileReason.href}
              cta={profileReason.cta}
            >
              {profileReason.text}
            </DisabledReason>
          ) : (
            <p className="text-xs text-ink-3">
              A new plan is private to you until you share or send it.
            </p>
          )}
        </div>
      </form>
    </Card>
  );
}
