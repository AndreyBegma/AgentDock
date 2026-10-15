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
  isRunnerTooOldError,
} from '../../../../../lib/planner/format';
import { planHref } from '../../../../../lib/planner/href';
import {
  plannerRunnerBlock,
  runnerGateCopy,
} from '../../../../../lib/planner/runner-support';
import { useErrorToast } from '../../../../../lib/section/use-error-toast';
import { useSection } from '../../../../../lib/section/use-section';
import { skillRunProfiles } from '../../../../../lib/skills/format';
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
  // #233: the runner's advert decides before any turn. Only a runner that
  // advertises nothing still teaches it by refusing a turn (#213) — the
  // newest plan's, or the one just tried.
  const runnerBlock = plannerRunnerBlock({
    project,
    createdTooOld,
    newestReason: plans.data?.items[0]?.attention?.reason,
  });
  const runnerCopy = runnerBlock
    ? runnerGateCopy('planner', runnerBlock.gate)
    : null;

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

  const [retrying, setRetrying] = useState<string | null>(null);
  const retry = async (plan: PlanSummary) => {
    const turnId = plan.attention?.turnId;
    if (!turnId) return;
    setRetrying(plan.id);
    try {
      await api(
        `/projects/${projectId}/plans/${plan.id}/turns/${turnId}/retry`,
        {
          method: 'POST',
        },
      );
    } catch (error) {
      showError(describePlannerError(error));
    } finally {
      setRetrying(null);
      setVersion((v) => v + 1);
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
        {runnerCopy ? (
          <PrerequisiteBanner
            tone="warn"
            title={runnerCopy.title}
            body={runnerCopy.body}
            href={runnerCopy.href}
            cta={runnerCopy.cta}
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
        runnerReason={
          runnerCopy && runnerBlock?.known
            ? {
                text: runnerCopy.reason,
                href: runnerCopy.href,
                cta: runnerCopy.cta,
              }
            : null
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
          {(view) => (
            <PlanList
              plans={view.items}
              retry={{ allowed: canOperate, retrying, onRetry: retry }}
            />
          )}
        </AsyncSection>
      </section>
    </div>
  );
}
