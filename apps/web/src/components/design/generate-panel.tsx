'use client';

import {
  DESIGN_SKILLS_MAX,
  DESIGN_VARIANTS_MAX,
  DESIGN_VARIANTS_MIN,
  type InstalledSkillsView,
  type TaskDesignPatchRequest,
  type TaskDesignView,
} from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { Combobox } from '@andrewbehma/glass-ui/combobox';
import { Field } from '@andrewbehma/glass-ui/field';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@andrewbehma/glass-ui/segmented-control';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { installedSkillsApi } from '../../lib/design/href';
import { useSection } from '../../lib/section/use-section';

const VARIANT_COUNTS = Array.from(
  { length: DESIGN_VARIANTS_MAX - DESIGN_VARIANTS_MIN + 1 },
  (_, i) => DESIGN_VARIANTS_MIN + i,
);

/**
 * Before the first revision (spec 223 D4, D15): how many variants, which
 * design skills — the planner's suggestion and the project's defaults
 * pre-filled — and **Generate**. The first design in a project builds the UI
 * profile first, and says so.
 */
export function GeneratePanel({
  projectId,
  design,
  writeBlock,
  busy,
  onPatch,
  onGenerate,
}: {
  projectId: string;
  design: TaskDesignView;
  writeBlock: string | null;
  busy: boolean;
  onPatch: (body: TaskDesignPatchRequest) => Promise<unknown>;
  onGenerate: () => Promise<unknown>;
}) {
  const [count, setCount] = useState(design.variantCount);
  const [skills, setSkills] = useState<string[]>(design.skills);
  useEffect(() => setCount(design.variantCount), [design.variantCount]);
  useEffect(() => setSkills(design.skills), [design.skills]);

  const installed = useSection(
    () => api<InstalledSkillsView>(installedSkillsApi(projectId)),
    [projectId],
  );
  const options = useMemo(() => {
    const names = new Set(
      (installed.data?.items ?? []).map((s) => s.invocation),
    );
    // A chosen skill that is gone stays listed, so it can be removed.
    for (const s of skills) names.add(s);
    return [...names].sort().map((name) => ({ value: name, label: name }));
  }, [installed.data, skills]);

  const changed =
    count !== design.variantCount ||
    skills.join('\n') !== design.skills.join('\n');

  const generate = async () => {
    try {
      if (changed) await onPatch({ variantCount: count, skills });
      await onGenerate();
    } catch {
      // Toasted by the caller.
    }
  };

  return (
    <section
      aria-label="Generate the design"
      className="mx-auto flex w-full max-w-md flex-col gap-4 rounded-lg border border-line bg-content p-6"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">Draw the mockup</h2>
        <p className="text-sm text-ink-2">
          {design.suggestionWhy
            ? `Planner: ${design.suggestionWhy}`
            : 'The planner draws the task as a self-contained HTML mockup in the project’s style.'}
        </p>
        {design.profileId === null ? (
          <p className="text-xs text-ink-3">
            This project has no UI profile yet: Generate builds it first, which
            takes a few minutes.
          </p>
        ) : null}
      </div>

      <Field label="Variants">
        <SegmentedControl size="sm" role="group" aria-label="Variants">
          {VARIANT_COUNTS.map((n) => (
            <SegmentedControlItem
              key={n}
              active={count === n}
              layoutId="design-variant-count"
            >
              <button
                type="button"
                aria-pressed={count === n}
                disabled={writeBlock !== null}
                className="min-w-10 px-3 py-1 text-xs"
                onClick={() => setCount(n)}
              >
                {n}
              </button>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </Field>

      <Field
        label="Design skills"
        hint={
          installed.error
            ? 'The installed skills could not be listed; the chosen ones are kept.'
            : `Up to ${DESIGN_SKILLS_MAX}. The project's defaults are pre-filled.`
        }
      >
        <Combobox
          multiple
          aria-label="Design skills"
          options={options}
          value={skills}
          disabled={writeBlock !== null}
          placeholder="No skills"
          onValueChange={(next) => setSkills(next.slice(0, DESIGN_SKILLS_MAX))}
        />
      </Field>

      {writeBlock ? <p className="text-xs text-ink-3">{writeBlock}</p> : null}
      <Button
        variant="solid"
        disabled={writeBlock !== null || busy}
        onClick={() => void generate()}
      >
        {busy ? 'Starting…' : 'Generate'}
      </Button>
    </section>
  );
}
