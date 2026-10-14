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
  defaultProfileOptionLabel,
  profileOptionLabel,
  SKILL_MODELS,
} from '../../lib/skills/format';

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
 * page's primary action.
 */
export function Composer({
  initialBrief,
  profiles,
  disabledReason,
  onCreate,
}: {
  /** `?brief=` from the Fleet canvas's "Plan this" (#160). */
  initialBrief: string;
  /** Claude profiles of the project's runner; empty = the default only. */
  profiles: readonly ProjectRuntimeProfile[];
  /** Why the person cannot start a plan (a viewer); null when they can. */
  disabledReason: string | null;
  /** Rejects to keep the form as it is. */
  onCreate: (request: CreatePlanRequest) => Promise<void>;
}) {
  const [brief, setBrief] = useState(initialBrief);
  const [mode, setMode] = useState<PlanMode>('batch');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [profileKey, setProfileKey] = useState('');
  const [busy, setBusy] = useState(false);
  const off = busy || disabledReason !== null;

  const submit = async () => {
    const text = brief.trim();
    if (!text || off) return;
    setBusy(true);
    try {
      await onCreate({
        brief: text,
        mode,
        ...(model !== DEFAULT_MODEL ? { model } : {}),
        ...(profileKey ? { profileKey } : {}),
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
        <div className="flex flex-col gap-4 md:flex-row md:items-end">
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-sm font-medium text-ink" id="planner-mode">
              Mode
            </span>
            <SegmentedControl aria-label="Mode" variant="on-glass">
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
          </div>
          <div className="grid min-w-0 flex-1 grid-cols-1 gap-4 sm:grid-cols-2">
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
                disabled={off}
                onChange={(e) => setProfileKey(e.target.value)}
              >
                <option value="">{defaultProfileOptionLabel(profiles)}</option>
                {profiles.map((p) => (
                  <option key={p.key} value={p.key}>
                    {profileOptionLabel(p)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {disabledReason ? (
            <p className="text-sm text-ink-3">{disabledReason}</p>
          ) : (
            <p className="text-xs text-ink-3">
              A new plan is private to you until you share or send it.
            </p>
          )}
          <Button type="submit" disabled={off || brief.trim() === ''}>
            {busy ? 'Starting…' : 'Plan'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
