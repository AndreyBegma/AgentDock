'use client';

import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import {
  PLANNER_LIVE_EVENT,
  type PlanListView,
  projectRoleAtLeast,
} from '@nautelle/shared';
import { Plus } from 'lucide-react';
import NextLink from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { PageHeader } from '../../../../../components/page-header/page-header';
import { PlanList } from '../../../../../components/planner/plan-list';
import { AsyncSection } from '../../../../../components/prerequisites/async-section';
import { api } from '../../../../../lib/api';
import { boardHref, boardNewWorkHref } from '../../../../../lib/board/href';
import { useLive } from '../../../../../lib/live/use-live';
import { useSection } from '../../../../../lib/section/use-section';
import { useProjectDetail } from '../use-project-detail';

/** One refetch for a burst of pushes. */
const REFETCH_DEBOUNCE_MS = 300;

/**
 * The retired Planner page (#337 D11): out of the navigation, kept so the
 * plans made here stay readable. New work starts on the Board (#409).
 */
export default function PlannerPage() {
  const { projectId } = useParams<{ projectId: string }>();
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
    () => api<PlanListView>(`/projects/${encodeURIComponent(projectId)}/plans`),
    [projectId, version],
  );

  const primaryAction = canOperate
    ? { label: 'New work', href: boardNewWorkHref(projectId), icon: Plus }
    : { label: 'Open the Board', href: boardHref(projectId) };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        className="mb-0"
        title="Plans"
        description="Plans made before the Planner moved onto the Board. They are read-only; new work starts on the Board."
        link={NextLink}
        primaryAction={primaryAction}
      />
      <AsyncSection
        section={plans}
        unavailable={{
          title: 'Plans could not be loaded',
          stillWorks: 'The Board is still available.',
        }}
        isEmpty={(view) => view.items.length === 0}
        empty={
          <EmptyState
            title="No plans"
            description="Plans are private to their author until shared, so a colleague’s plan shows here once they share it. New work starts on the Board."
            link={NextLink}
            action={{
              label: canOperate ? 'New work on the Board' : 'Open the Board',
              href: canOperate
                ? boardNewWorkHref(projectId)
                : boardHref(projectId),
            }}
          />
        }
      >
        {(view) => <PlanList plans={view.items} />}
      </AsyncSection>
    </div>
  );
}
