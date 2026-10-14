'use client';

import type {
  PlannerInstructionsUpdateRequest,
  PlannerInstructionsView,
} from '@agentdock/shared';
import { buttonClassName } from '@andrewbehma/glass-ui/button';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PageHeader } from '../../../components/page-header/page-header';
import { AsyncSection } from '../../../components/prerequisites/async-section';
import { api } from '../../../lib/api';
import { useSection } from '../../../lib/section/use-section';
import { InstructionsEditor } from './instructions-editor';

/**
 * A way back on a phone, where the top bar has no parent to offer for an
 * admin page: one step back in the history, else Overview.
 */
function BackLink() {
  const router = useRouter();
  return (
    <Link
      href="/"
      className={`${buttonClassName({ variant: 'ghost', size: 'sm' })} -ml-2 self-start lg:hidden`}
      onClick={(event) => {
        if (window.history.length > 1) {
          event.preventDefault();
          router.back();
        }
      }}
    >
      <ArrowLeft size={14} aria-hidden="true" />
      Back
    </Link>
  );
}

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
      <BackLink />
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
