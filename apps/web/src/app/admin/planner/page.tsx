'use client';

import type {
  PlannerInstructionsUpdateRequest,
  PlannerInstructionsView,
} from '@agentdock/shared';
import { PageHeader } from '../../../components/page-header/page-header';
import { AsyncSection } from '../../../components/prerequisites/async-section';
import { api } from '../../../lib/api';
import { useSection } from '../../../lib/section/use-section';
import { InstructionsEditor } from './instructions-editor';

export default function AdminPlannerPage() {
  const instructions = useSection(
    () => api<PlannerInstructionsView>('/admin/planner/instructions'),
    [],
  );
  const { retry } = instructions;

  const save = async (body: string) => {
    await api<PlannerInstructionsView>('/admin/planner/instructions', {
      method: 'PUT',
      body: { body } satisfies PlannerInstructionsUpdateRequest,
    });
    retry();
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        className="mb-0"
        eyebrow="Admin"
        title="Planner instructions"
        description="The default instructions every project's planner runs with, unless the project sets its own. Each save is a new version, and each plan records the version it ran with."
      />
      <AsyncSection
        section={instructions}
        unavailable={{
          title: 'The instructions could not be loaded',
          stillWorks: 'Projects keep planning with the current version.',
        }}
        empty={null}
        isEmpty={() => false}
      >
        {(data) => (
          <InstructionsEditor
            current={data.current}
            versions={data.versions}
            contract={data.contract}
            contractVersion={data.contractVersion}
            canEdit
            onSave={save}
          />
        )}
      </AsyncSection>
    </div>
  );
}
