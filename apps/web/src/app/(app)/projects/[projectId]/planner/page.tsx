'use client';

import {
  PLANNER_LIVE_EVENT,
  type PlanListView,
  projectRoleAtLeast,
} from '@agentdock/shared';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { buttonClassName } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { PageHeader } from '../../../../../components/page-header/page-header';
import { PlanList } from '../../../../../components/planner/plan-list';
import { AsyncSection } from '../../../../../components/prerequisites/async-section';
import { api } from '../../../../../lib/api';
import { boardHref, boardNewPlanHref } from '../../../../../lib/board/href';
import { useLive } from '../../../../../lib/live/use-live';
import { useSection } from '../../../../../lib/section/use-section';
import { useProjectDetail } from '../use-project-detail';

/** One refetch for a burst of pushes. */
const REFETCH_DEBOUNCE_MS = 300;

/**
 * The retired Planner page (#337 D11): out of the navigation, kept so the
 * plans made here stay readable. New plans start on the Board (New Plan,
 * New Card).
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
    () => api<PlanListView>(`/projects/${projectId}/plans`),
    [projectId, version],
  );

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        className="mb-0"
        title="Plans"
        description="Plans made before the Planner moved onto the Board. They are read-only; their tasks show on the Board until a plan is archived."
      />
      <Banner
        tone="info"
        title="New plans start on the Board"
        action={
          <Link
            href={
              canOperate ? boardNewPlanHref(projectId) : boardHref(projectId)
            }
            className={buttonClassName({ variant: 'glass', size: 'sm' })}
          >
            {canOperate ? 'New Plan on the Board' : 'Open the Board'}
          </Link>
        }
      >
        New Card interviews you and writes one card; New Plan makes several
        cards, or sends them to the fleet.
      </Banner>

      <section aria-labelledby="plans" className="flex flex-col gap-3">
        <SectionHeader title="Plans" headingId="plans" />
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
              description="Plans are private to their author until shared, so a colleague’s plan shows here once they share it."
            />
          }
        >
          {(view) => <PlanList plans={view.items} />}
        </AsyncSection>
      </section>
    </div>
  );
}
