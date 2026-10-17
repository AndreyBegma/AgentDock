'use client';

import {
  type CardDesignLaunchRequest,
  claudeModelLabel,
  DESIGN_SKILLS_MAX,
  DESIGN_VARIANTS_MAX,
  DESIGN_VARIANTS_MIN,
  type InstalledSkillsView,
  type ProjectDetail,
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
import {
  type LaunchCard,
  type LaunchForm,
  launchBaseline,
  launchChanges,
  launchDefaults,
  launchRequest,
  launchSavedNote,
  NO_RECOMMENDATION_TEXT,
} from '../../lib/board/launch';
import { generateRunnerGate } from '../../lib/design/format';
import { installedSkillsApi } from '../../lib/design/href';
import { runnerGateCopy } from '../../lib/planner/runner-support';
import { useReadiness } from '../../lib/readiness/use-readiness';
import { useSection } from '../../lib/section/use-section';
import { LaunchSelects } from '../board/launch-popover';
import { DisabledReason } from '../prerequisites/disabled-reason';
import { ReadinessNotice } from '../readiness/readiness-notice';

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
  stackBlock = null,
  stackHref,
  busy,
  onPatch,
  onGenerate,
  launch,
}: {
  projectId: string;
  design: TaskDesignView;
  writeBlock: string | null;
  /** #527: a stack card's own design waits for the stack's approved one. */
  stackBlock?: string | null;
  /** With `stackBlock`: the stack design's viewer. */
  stackHref?: string;
  busy: boolean;
  onPatch: (body: TaskDesignPatchRequest) => Promise<unknown>;
  onGenerate: (body?: CardDesignLaunchRequest) => Promise<unknown>;
  /** A card's design (#322 D1): the inline "Runs on" group, sent with Generate. */
  launch?: LaunchCard;
}) {
  // #322 D1: a card's profile and model, chosen here instead of in a popover.
  const [runsOn, setRunsOn] = useState<LaunchForm>(() =>
    launch ? launchDefaults(launch, 'design') : { profileKey: '', model: '' },
  );
  const runsOnChanges = launch ? launchChanges(runsOn, launch, 'design') : [];
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

  // #233: a runner that advertised its commands without the design ones is
  // said before Generate, not after a refused turn.
  const project = useSection(
    () => api<ProjectDetail>(`/projects/${projectId}`),
    [projectId],
  );
  const gate = generateRunnerGate(project.data);
  const runnerCopy = gate ? runnerGateCopy('design', gate) : null;
  // #272: no usable profile (or an offline runner) is said before Generate.
  const readiness = useReadiness(projectId);
  const notReady = readiness
    .blockers('design')
    .some((blocker) => blocker.code !== 'runner_outdated');

  const changed =
    count !== design.variantCount ||
    skills.join('\n') !== design.skills.join('\n');

  const blocked =
    writeBlock !== null ||
    stackBlock !== null ||
    runnerCopy !== null ||
    notReady;
  const describedBy =
    writeBlock !== null
      ? undefined
      : stackBlock !== null
        ? 'design-stack-reason'
        : runnerCopy
          ? 'design-runner-reason'
          : notReady
            ? 'design-readiness-reason'
            : undefined;

  const generate = async () => {
    try {
      if (changed) await onPatch({ variantCount: count, skills });
      await onGenerate(launch ? launchRequest(runsOn) : undefined);
    } catch {
      // Toasted by the caller.
    }
  };

  return (
    <section
      aria-label="Generate the design"
      // #526: below `lg` every control is 44px (the tokens glass-ui reads), the
      // text inputs are 16px so iOS does not zoom on focus, and Generate sits
      // in a dock above the capsule (#521), or above the keyboard while it is up.
      className="mx-auto flex w-full max-w-md flex-col gap-4 rounded-lg border border-line bg-content p-4 max-lg:[--size-control:44px] max-lg:[--size-field:44px] max-lg:[&_input]:text-base max-lg:[&_select]:text-base lg:p-6"
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
                className="w-full min-w-10 px-3 py-1 text-xs max-lg:h-full max-lg:text-sm"
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
          placeholder="Add a skill"
          onValueChange={(next) => setSkills(next.slice(0, DESIGN_SKILLS_MAX))}
        />
      </Field>

      {launch ? (
        <fieldset
          aria-labelledby="design-runs-on"
          className="flex min-w-0 flex-col gap-3 rounded-control border border-line p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <span id="design-runs-on" className="text-sm font-medium">
              Runs on
            </span>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              className="max-lg:h-11"
              disabled={runsOnChanges.length === 0 || writeBlock !== null}
              onClick={() => setRunsOn(launchBaseline(launch, 'design'))}
            >
              Use defaults
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <LaunchSelects
              projectId={projectId}
              card={launch}
              kind="design"
              form={runsOn}
              onChange={setRunsOn}
              disabled={writeBlock !== null}
            />
          </div>
          <p className="text-xs text-ink-2">
            {launch.recommendation.design
              ? `Recommended: ${launch.recommendation.design.reason}`
              : NO_RECOMMENDATION_TEXT}
          </p>
          {launchSavedNote(runsOnChanges, 'this card') ? (
            <p role="status" className="text-xs text-ink-2">
              {launchSavedNote(runsOnChanges, 'this card')}
            </p>
          ) : null}
        </fieldset>
      ) : null}

      {writeBlock ? (
        <p className="text-xs text-ink-3">{writeBlock}</p>
      ) : stackBlock ? (
        <DisabledReason
          id="design-stack-reason"
          href={stackHref}
          cta="Open the stack design"
        >
          {stackBlock}
        </DisabledReason>
      ) : runnerCopy ? (
        <DisabledReason
          id="design-runner-reason"
          href={runnerCopy.href}
          cta={runnerCopy.cta}
        >
          {runnerCopy.reason}
        </DisabledReason>
      ) : null}
      {writeBlock === null ? (
        <ReadinessNotice
          id="design-readiness-reason"
          projectId={projectId}
          action="design"
          readiness={readiness}
          exclude={['runner_outdated']}
        />
      ) : null}
      <div aria-hidden="true" className="h-14 lg:hidden" />
      <div className="max-lg:glass-strong max-lg:fixed max-lg:inset-x-4 max-lg:bottom-[calc(var(--dock-bottom)+0.5rem)] max-lg:z-chrome max-lg:rounded-sheet max-lg:p-2">
        <Button
          variant="solid"
          full
          disabled={blocked || busy}
          aria-describedby={describedBy}
          onClick={() => void generate()}
        >
          {busy ? 'Starting…' : 'Generate'}
        </Button>
      </div>
      {launch ? (
        <p className="text-center text-xs text-ink-3">
          {count} {count === 1 ? 'variant' : 'variants'} ·{' '}
          {runsOn.model ? claudeModelLabel(runsOn.model) : 'Project model'} on{' '}
          {runsOn.profileKey || 'the default profile'}
        </p>
      ) : null}
    </section>
  );
}
