'use client';

import {
  PLANNER_SPEC_OUTPUTS,
  type PlannerSettingsUpdateRequest,
  type PlannerSettingsView,
  type PlannerSpecOutput,
} from '@agentdock/shared';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@andrewbehma/glass-ui/segmented-control';
import { toast } from '@andrewbehma/glass-ui/toast';
import { useState } from 'react';
import { AsyncSection } from '../../../../../components/prerequisites/async-section';
import { api } from '../../../../../lib/api';
import { useErrorToast } from '../../../../../lib/section/use-error-toast';
import { useSection } from '../../../../../lib/section/use-section';
import {
  describePlannerError,
  SPEC_OUTPUT_HINT,
  SPEC_OUTPUT_LABEL,
} from '../../../../../lib/tasks/format';
import { InstructionsEditor } from '../../../../admin/planner/instructions-editor';

/**
 * Project settings → Planner (spec 172 D10, D11): how a feature's
 * specification is published, and this project's override of the planner's
 * instructions. Every member reads; only a project admin changes either.
 */
export function PlannerTab({
  projectId,
  isAdmin,
}: {
  projectId: string;
  isAdmin: boolean;
}) {
  const settings = useSection(
    () => api<PlannerSettingsView>(`/projects/${projectId}/planner/settings`),
    [projectId],
  );
  const { retry } = settings;
  const [busy, setBusy] = useState(false);
  const showError = useErrorToast();

  const put = (body: PlannerSettingsUpdateRequest) =>
    api<PlannerSettingsView>(`/projects/${projectId}/planner/settings`, {
      method: 'PUT',
      body,
    });

  const changeOutput = async (next: PlannerSpecOutput) => {
    setBusy(true);
    try {
      await put({ specOutput: next });
      toast.success('Specification output saved');
      retry();
    } catch (err) {
      showError(describePlannerError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AsyncSection
      section={settings}
      unavailable={{
        title: 'The planner settings could not be loaded',
        stillWorks: 'The planner keeps working with the saved settings.',
      }}
      empty={null}
      isEmpty={() => false}
    >
      {(data) => (
        <div className="flex flex-col gap-6">
          <section
            className="flex flex-col gap-2"
            aria-label="Specification output"
          >
            <h2 className="text-base font-semibold">Specification output</h2>
            <p className="max-w-prose text-sm text-ink-2">
              How a feature task's specification reaches GitHub when a plan is
              sent to the fleet.
              {isAdmin ? '' : ' Only a project admin can change this.'}
            </p>
            <SegmentedControl
              role="group"
              aria-label="Specification output"
              className="max-w-sm"
            >
              {PLANNER_SPEC_OUTPUTS.map((value) => (
                <SegmentedControlItem
                  key={value}
                  active={data.specOutput === value}
                  layoutId="planner-spec-output"
                >
                  <button
                    type="button"
                    aria-pressed={data.specOutput === value}
                    disabled={!isAdmin || busy}
                    className="w-full min-w-24 px-3 py-1.5 text-sm whitespace-nowrap"
                    onClick={() => {
                      if (data.specOutput !== value) void changeOutput(value);
                    }}
                  >
                    {SPEC_OUTPUT_LABEL[value]}
                  </button>
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
            <p className="max-w-prose text-xs text-ink-3">
              {SPEC_OUTPUT_HINT[data.specOutput]}
            </p>
          </section>

          <InstructionsEditor
            current={data.override}
            versions={data.overrideVersions}
            contract={data.contract}
            contractVersion={data.contractVersion}
            canEdit={isAdmin}
            allowClear
            noCurrentNote="This project uses the global instructions. Write an override here to replace them for this project only."
            onSave={async (body) => {
              await put({
                specOutput: data.specOutput,
                instructionsOverride: body,
              });
              retry();
            }}
          />
        </div>
      )}
    </AsyncSection>
  );
}
