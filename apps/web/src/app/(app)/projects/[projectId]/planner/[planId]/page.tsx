'use client';

import type { PlannerSettingsView, UiProfileView } from '@agentdock/shared';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { buttonClassName } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { PlanWorkspace } from '../../../../../../components/planner/plan-workspace';
import { AsyncSection } from '../../../../../../components/prerequisites/async-section';
import { useCurrentUser } from '../../../../../../components/shell/user-context';
import { api } from '../../../../../../lib/api';
import { boardHref } from '../../../../../../lib/board/href';
import { uiProfileApi } from '../../../../../../lib/design/href';
import { isNotFound } from '../../../../../../lib/planner/format';
import { planHref, plannerHref } from '../../../../../../lib/planner/href';
import { usePlan } from '../../../../../../lib/planner/use-plan';
import { useSection } from '../../../../../../lib/section/use-section';
import { useProjectDetail } from '../../use-project-detail';

/**
 * A plan on the retired Planner page (#337 D11): read-only — no turns, no
 * reviews, no send. Its tasks keep projecting onto the Board until it is
 * closed, and Archive closes it. New work starts on the Board (#409).
 * `?task=<key>` selects a task; it is the deep link `/tasks` rows open.
 */
export default function PlanPage() {
  const { projectId, planId } = useParams<{
    projectId: string;
    planId: string;
  }>();
  const router = useRouter();
  const search = useSearchParams();
  const selectedKey = search.get('task');
  const select = (key: string | null) =>
    router.replace(planHref(projectId, planId, key), { scroll: false });

  const user = useCurrentUser();
  const project = useProjectDetail(projectId).data;
  const role = project?.role ?? 'viewer';
  const section = usePlan(projectId, planId);
  const settings = useSection(
    () => api<PlannerSettingsView>(`/projects/${projectId}/planner/settings`),
    [projectId],
  );
  // D3: a project whose profile says it has no UI hides the design toggle.
  // A profile that does not load is treated as none: the toggle shows.
  const profile = useSection(
    () => api<UiProfileView>(uiProfileApi(projectId)),
    [projectId],
  );

  if (section.data === undefined && isNotFound(section.error)) {
    return (
      <EmptyState
        title="Plan not found"
        description="It was removed, or it is private to its author."
        action={
          <Link
            href={plannerHref(projectId)}
            className={buttonClassName({ variant: 'glass' })}
          >
            Open the plan list
          </Link>
        }
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Banner
        tone="info"
        title="This plan is read-only"
        action={
          <Link
            href={boardHref(projectId)}
            className={buttonClassName({ variant: 'glass', size: 'sm' })}
          >
            Open the Board
          </Link>
        }
      >
        The Planner moved onto the Board: New work starts there. This plan’s
        tasks still show on the Board until it is archived.
      </Banner>
      <AsyncSection
        section={section}
        unavailable={{
          title: 'The plan could not be loaded',
          stillWorks: 'Fleet, queue and history are still available.',
        }}
        empty={null}
      >
        {(plan) => (
          <PlanWorkspace
            plan={plan}
            projectId={projectId}
            selectedKey={selectedKey}
            onSelect={select}
            isAuthor={plan.author.id === user.id}
            isProjectAdmin={role === 'admin'}
            canOperate={false}
            specOutput={settings.data?.specOutput}
            busy={section.busy}
            actions={section.actions}
            hasUi={profile.data?.current?.hasUi ?? null}
            onRefresh={section.retry}
            onArchived={() => router.push(plannerHref(projectId))}
            readOnly
          />
        )}
      </AsyncSection>
    </div>
  );
}
