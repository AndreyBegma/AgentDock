'use client';

import {
  type ActivityPage,
  type ApprovalsView,
  FLEET_LIVE_EVENT,
  type FleetView,
  projectRoleAtLeast,
  type QueueView,
  RUN_UPDATED_LIVE_EVENT,
  type RunPage,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import type { PageHeaderOverflowItem } from '@andrewbehma/glass-ui/page-header';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { ArrowRight, Plus } from 'lucide-react';
import NextLink from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { BudgetExceededBanner } from '../../../../components/budgets/exceeded-banner';
import { PageHeader } from '../../../../components/page-header/page-header';
import { RunnerOfflineBanner } from '../../../../components/prerequisites/prerequisite-banner';
import { api } from '../../../../lib/api';
import { boardHref, boardNewPlanHref } from '../../../../lib/board/href';
import {
  isNotFound,
  ORCHESTRATOR_STATUS_LABEL,
} from '../../../../lib/fleet/format';
import { projectHue } from '../../../../lib/hue';
import { useLive } from '../../../../lib/live/use-live';
import {
  needsYou,
  summarySentence,
} from '../../../../lib/project-home/summary';
import { allowedLabels } from '../../../../lib/queue/format';
import { useSection } from '../../../../lib/section/use-section';
import { ORCHESTRATOR_PILL_STATUS } from '../../../../lib/status/pill';
import {
  FleetGlanceSection,
  NeedsYouSection,
  RecentActivitySection,
  RecentResultSection,
} from './home/home-sections';
import { NewIssueDialog } from './queue/new-issue-dialog';
import { useProjectDetail } from './use-project-detail';

/** Pushes arrive in bursts; one refetch covers them. */
const REFETCH_DEBOUNCE_MS = 300;
/** The latest result is picked from this many runs (housekeeping is left out). */
const RECENT_FETCH = 20;
const ACTIVITY_LIMIT = 5;
const NEXT_WAVE_BRIEF = 'Plan the next wave of work for this project.';

/**
 * A project's home (C-283): a short summary — what is running, what waits for
 * the person, the latest result — and one primary action, Open Board. The
 * figures the Board, Queue and Activity already show are not repeated here;
 * Usage keeps the cost and History the runs.
 */
export default function ProjectHomePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();

  /** Bumped by a live push; the live sections reload. */
  const [version, setVersion] = useState(0);
  const [creating, setCreating] = useState(false);
  const detail = useProjectDetail(projectId);
  const project = detail.data;
  const canOperate = projectRoleAtLeast(project?.role ?? 'viewer', 'operator');

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useLive(`project:${projectId}`, (message) => {
    if (
      message.event !== FLEET_LIVE_EVENT &&
      message.event !== RUN_UPDATED_LIVE_EVENT
    ) {
      return;
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setVersion((v) => v + 1),
      REFETCH_DEBOUNCE_MS,
    );
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  const base = `/projects/${projectId}`;
  const runs = useSection(
    () => api<RunPage>(`${base}/runs?limit=${RECENT_FETCH}`),
    [base, version],
  );
  const approvals = useSection(
    () => api<ApprovalsView>(`${base}/approvals`),
    [base, version],
  );
  const fleet = useSection(
    () => api<FleetView>(`${base}/fleet`),
    [base, version],
  );
  const activity = useSection(
    () =>
      api<ActivityPage>(
        `/activity?${new URLSearchParams({ projectId, limit: String(ACTIVITY_LIMIT) })}`,
      ),
    [projectId, version],
  );
  // The new-issue dialog's label choices; asked for only once it opens.
  const openIssues = useSection<QueueView | undefined>(
    () =>
      creating
        ? api<QueueView>(`${base}/queue?include=open`)
        : Promise.resolve(undefined),
    [base, creating],
  );

  if (project === undefined && isNotFound(detail.error)) {
    return (
      <EmptyState
        title="Project not found"
        description="It was removed, or you are not a member of it."
        link={NextLink}
        action={{ label: 'Open Projects', href: '/projects' }}
      />
    );
  }

  const orchestrator = fleet.data?.orchestrator.status;
  const waiting = needsYou(
    projectId,
    approvals.data,
    fleet.data,
    runs.data?.items ?? [],
  ).length;
  const overflow: PageHeaderOverflowItem[] = [
    {
      id: 'plan',
      label: 'Plan next wave',
      onSelect: () => router.push(boardNewPlanHref(projectId, NEXT_WAVE_BRIEF)),
    },
    {
      id: 'usage',
      label: 'Usage and cost',
      onSelect: () =>
        router.push(`/usage?projectId=${encodeURIComponent(projectId)}`),
    },
    {
      id: 'history',
      label: 'Run history',
      onSelect: () => router.push(`${base}/history`),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        className="mb-0"
        link={NextLink}
        eyebrow={
          project ? (
            <span className="inline-flex items-center gap-2">
              {/* Identity is square; a round dot means status (#213). */}
              <Badge
                shape="square"
                hue={projectHue(projectId)}
                aria-hidden="true"
              />
              {project.repo} · {project.base}
            </span>
          ) : undefined
        }
        title={project?.displayName ?? 'Project'}
        description={
          summarySentence(fleet.data, waiting) ??
          'What is running, what waits for you and the latest result.'
        }
        {...(orchestrator
          ? {
              status: (
                <StatusPill
                  status={ORCHESTRATOR_PILL_STATUS[orchestrator]}
                  label={`Orchestrator ${ORCHESTRATOR_STATUS_LABEL[orchestrator].toLowerCase()}`}
                />
              ),
            }
          : {})}
        actions={
          canOperate ? (
            <Button variant="glass" onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" className="size-4" />
              New task
            </Button>
          ) : undefined
        }
        primaryAction={{
          label: 'Open Board',
          href: boardHref(projectId),
          icon: ArrowRight,
        }}
        overflow={overflow}
      />
      {project ? <RunnerOfflineBanner project={project} /> : null}
      <BudgetExceededBanner projectId={projectId} />

      <NeedsYouSection
        projectId={projectId}
        approvals={approvals}
        fleet={fleet}
        runs={runs}
      />
      <RecentResultSection projectId={projectId} runs={runs} />
      <div className="grid grid-cols-1 gap-6 tablet:grid-cols-2">
        <FleetGlanceSection projectId={projectId} fleet={fleet} />
        <RecentActivitySection projectId={projectId} activity={activity} />
      </div>

      {canOperate ? (
        <NewIssueDialog
          projectId={projectId}
          open={creating}
          labelChoices={allowedLabels(openIssues.data)}
          {...(project ? { runnerName: project.runnerName } : {})}
          onOpenChange={setCreating}
          onCreated={() => setVersion((v) => v + 1)}
        />
      ) : null}
    </div>
  );
}
