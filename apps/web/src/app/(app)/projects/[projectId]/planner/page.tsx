'use client';

import {
  type CreatePlanRequest,
  PLANNER_LIVE_EVENT,
  type PlanListView,
  type PlanSummary,
  type ProjectRuntimeProfile,
  projectRoleAtLeast,
} from '@agentdock/shared';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { PageHeader } from '../../../../../components/page-header/page-header';
import { Composer } from '../../../../../components/planner/composer';
import { PlanList } from '../../../../../components/planner/plan-list';
import { AsyncSection } from '../../../../../components/prerequisites/async-section';
import {
  PrerequisiteBanner,
  RunnerOfflineBanner,
} from '../../../../../components/prerequisites/prerequisite-banner';
import { api } from '../../../../../lib/api';
import { useLive } from '../../../../../lib/live/use-live';
import {
  describePlannerError,
  isRunnerTooOld,
  isRunnerTooOldError,
  RUNNER_TOO_OLD_TEXT,
} from '../../../../../lib/planner/format';
import { planHref } from '../../../../../lib/planner/href';
import { useErrorToast } from '../../../../../lib/section/use-error-toast';
import { useSection } from '../../../../../lib/section/use-section';
import { skillRunProfiles } from '../../../../../lib/skills/format';
import { RUNNER_UPDATE_HREF } from '../../../../../lib/slot/format';
import { useProjectDetail } from '../use-project-detail';

/** One refetch for a burst of pushes. */
const REFETCH_DEBOUNCE_MS = 300;

/**
 * The Planner (spec 172): write a brief, and the planner splits it into bugs
 * and features to review, talk through and send to the fleet. Below the
 * composer, the plans the person may read.
 */
export default function PlannerPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const brief = useSearchParams().get('brief') ?? '';
  const detail = useProjectDetail(projectId);
  const project = detail.data;
  const canOperate =
    project !== undefined && projectRoleAtLeast(project.role, 'operator');

  const [version, setVersion] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useLive(`project:${projectId}`, (message) => {
    if (message.event !== PLANNER_LIVE_EVENT) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setVersion((v) => v + 1),
      REFETCH_DEBOUNCE_MS,
    );
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  const plans = useSection(
    () => api<PlanListView>(`/projects/${projectId}/plans`),
    [projectId, version],
  );
  const profiles = useSection<ProjectRuntimeProfile[]>(
    () =>
      canOperate
        ? api<ProjectRuntimeProfile[]>(
            `/projects/${projectId}/runtime-profiles`,
          ).then(skillRunProfiles)
        : Promise.resolve([]),
    [canOperate, projectId],
  );

  const showError = useErrorToast();
  const [createdTooOld, setCreatedTooOld] = useState(false);
  // #213: until the runner advertises its commands, the planner learns it is
  // too old from a turn it refused — the newest plan's, or the one just tried.
  const newest = plans.data?.items[0];
  const runnerTooOld =
    createdTooOld || isRunnerTooOld(newest?.attention?.reason);

  const create = async (request: CreatePlanRequest) => {
    try {
      const plan = await api<PlanSummary>(`/projects/${projectId}/plans`, {
        method: 'POST',
        body: request,
      });
      router.push(planHref(projectId, plan.id));
    } catch (error) {
      setCreatedTooOld(isRunnerTooOldError(error));
      showError(describePlannerError(error));
      throw error;
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-col gap-3">
        <PageHeader
          className="mb-0"
          title="Planner"
          description="Turn a brief into reviewed bugs and features, talk each one through, and send them to the fleet as issues."
        />
        {project ? <RunnerOfflineBanner project={project} /> : null}
        {runnerTooOld && project?.runnerStatus !== 'offline' ? (
          <PrerequisiteBanner
            tone="warn"
            title="The runner is too old to plan"
            body={RUNNER_TOO_OLD_TEXT}
            href={RUNNER_UPDATE_HREF}
            cta="Update the runner"
          />
        ) : null}
      </div>

      <Composer
        projectId={projectId}
        initialBrief={brief}
        profiles={profiles.error ? 'failed' : profiles.data}
        disabledReason={
          project === undefined
            ? 'Loading the project…'
            : canOperate
              ? null
              : 'Viewers can read shared plans; an operator starts one.'
        }
        onCreate={create}
      />

      <section aria-labelledby="plans" className="flex flex-col gap-3">
        <SectionHeader title="Plans" headingId="plans" />
        <AsyncSection
          section={plans}
          unavailable={{
            title: 'Plans could not be loaded',
            stillWorks: 'You can still start a new plan.',
          }}
          isEmpty={(view) => view.items.length === 0}
          empty={
            <EmptyState
              title="No plans yet"
              description="Write a brief above. Plans are private to their author until shared, so a colleague’s plan shows here once they share it."
            />
          }
        >
          {(view) => <PlanList plans={view.items} />}
        </AsyncSection>
      </section>
    </div>
  );
}
