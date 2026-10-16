'use client';

import {
  type ActivityPage,
  type ApprovalsView,
  type BudgetView,
  FLEET_LIVE_EVENT,
  type FleetGraph,
  type FleetView,
  projectRoleAtLeast,
  type QueueView,
  RUN_PAGE_MAX,
  RUN_UPDATED_LIVE_EVENT,
  type RunPage,
  type UsageSummaryResponse,
  type UsageTimeseriesResponse,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@andrewbehma/glass-ui/segmented-control';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { Plus } from 'lucide-react';
import NextLink from 'next/link';
import {
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
} from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { BudgetExceededBanner } from '../../../../components/budgets/exceeded-banner';
import { PageHeader } from '../../../../components/page-header/page-header';
import { RunnerOfflineBanner } from '../../../../components/prerequisites/prerequisite-banner';
import { api } from '../../../../lib/api';
import { boardNewPlanHref } from '../../../../lib/board/href';
import { useControl } from '../../../../lib/control/use-control';
import {
  isNotFound,
  ORCHESTRATOR_STATUS_LABEL,
} from '../../../../lib/fleet/format';
import { projectHue } from '../../../../lib/hue';
import { useLive } from '../../../../lib/live/use-live';
import {
  PROJECT_PERIODS,
  parsePeriod,
  periodRanges,
} from '../../../../lib/project-home/analytics';
import { allowedLabels } from '../../../../lib/queue/format';
import { useSection } from '../../../../lib/section/use-section';
import { ORCHESTRATOR_PILL_STATUS } from '../../../../lib/status/pill';
import { browserZone, rangeQuery } from '../../../../lib/usage/format';
import { useDesktop } from './fleet/use-desktop';
import { OrchestratorSection } from './home/orchestrator-section';
import {
  ProjectStats,
  ThroughputCard,
  WorkBreakdownCard,
} from './home/project-analytics';
import { RecentTasks } from './home/recent-tasks';
import { NewIssueDialog } from './queue/new-issue-dialog';
import { useProjectDetail } from './use-project-detail';

/** Pushes arrive in bursts; one refetch covers them. */
const REFETCH_DEBOUNCE_MS = 300;
/** Recent tasks are filtered from this many runs (housekeeping is left out). */
const RECENT_FETCH = 20;
const LOG_LIMIT = 8;
const NEXT_WAVE_BRIEF = 'Plan the next wave of work for this project.';
const ORCHESTRATOR_PARAM = 'orchestrator';

export default function ProjectHomePage() {
  // `useSearchParams` needs a boundary, or the route cannot prerender its shell.
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <ProjectHome />
    </Suspense>
  );
}

/**
 * A project's home (card C-6): how the project is moving first — the
 * period's figures, throughput, where the work went and the latest tasks —
 * then the orchestrator, folded, with the agent tree one click away.
 */
function ProjectHome() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const period = parsePeriod(searchParams.get('period'));
  const orchestratorOpen = searchParams.get(ORCHESTRATOR_PARAM) === 'open';
  const setParam = (key: string, value: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === null) params.delete(key);
    else params.set(key, value);
    const text = params.toString();
    router.replace(`${pathname}${text ? `?${text}` : ''}`, { scroll: false });
  };

  /** Bumped by a live push; the live sections reload. */
  const [version, setVersion] = useState(0);
  const [creating, setCreating] = useState(false);
  const desktop = useDesktop();
  const detail = useProjectDetail(projectId);
  const project = detail.data;
  const role = project?.role ?? 'viewer';
  const isAdmin = role === 'admin';
  const canOperate = projectRoleAtLeast(role, 'operator');
  const control = useControl(projectId, isAdmin);

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

  // The ranges move with the period, and with a push: "now" moved too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version moves "now"
  const ranges = useMemo(() => periodRanges(period), [period, version]);
  const { current, previous } = ranges;
  const base = `/projects/${projectId}`;

  const runs = useSection(
    () =>
      api<RunPage>(
        `${base}/runs?${new URLSearchParams({ from: current.from, limit: String(RUN_PAGE_MAX) })}`,
      ),
    [base, current.from, version],
  );
  // Only its counts are read: a page of one is enough.
  const previousRuns = useSection(
    () =>
      api<RunPage>(
        `${base}/runs?${new URLSearchParams({ from: previous.from, to: previous.to, limit: '1' })}`,
      ),
    [base, previous.from],
  );
  const recent = useSection(
    () => api<RunPage>(`${base}/runs?limit=${RECENT_FETCH}`),
    [base, version],
  );
  const cost = useSection(
    () =>
      api<UsageSummaryResponse>(
        `/usage/summary${rangeQuery(current, projectId)}`,
      ),
    [projectId, current.from, version],
  );
  const previousCost = useSection(
    () =>
      api<UsageSummaryResponse>(
        `/usage/summary${rangeQuery(previous, projectId)}`,
      ),
    [projectId, previous.from],
  );
  const costSeries = useSection(
    () =>
      api<UsageTimeseriesResponse>(
        `/usage/timeseries${rangeQuery(current, projectId, {
          interval: period === '24h' ? 'hour' : 'day',
          tz: browserZone(),
        })}`,
      ),
    [projectId, current.from, version],
  );
  const budgets = useSection(
    () => api<BudgetView[]>(`${base}/budgets`),
    [base],
  );
  const queue = useSection(() => api<QueueView>(`${base}/queue`), [base]);
  // The new-issue dialog's label choices; asked for only once it opens.
  const openIssues = useSection<QueueView | undefined>(
    () =>
      creating
        ? api<QueueView>(`${base}/queue?include=open`)
        : Promise.resolve(undefined),
    [base, creating],
  );
  const approvals = useSection(
    () => api<ApprovalsView>(`${base}/approvals`),
    [base, version],
  );
  const fleet = useSection(
    () => api<FleetView>(`${base}/fleet`),
    [base, version],
  );
  const graph = useSection<FleetGraph | undefined>(
    () =>
      orchestratorOpen
        ? api<FleetGraph>(`${base}/fleet/graph`)
        : Promise.resolve(undefined),
    [base, orchestratorOpen, version],
  );
  const activity = useSection(
    () =>
      api<ActivityPage>(
        `/activity?${new URLSearchParams({ projectId, limit: String(LOG_LIMIT) })}`,
      ),
    [projectId, version],
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
  const figures = {
    runs,
    previousRuns,
    cost,
    previousCost,
    costSeries,
    budgets,
    queue,
    approvals,
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        className="mb-0"
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
        description="How the project is moving: throughput, cost and the latest tasks. The live fleet is one click below."
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
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl size="sm" role="group" aria-label="Period">
              {PROJECT_PERIODS.map((p) => (
                <SegmentedControlItem
                  key={p}
                  active={p === period}
                  layoutId="project-period"
                >
                  <button
                    type="button"
                    aria-pressed={p === period}
                    className="w-full px-3 text-sm whitespace-nowrap"
                    onClick={() => setParam('period', p === '7d' ? null : p)}
                  >
                    {p}
                  </button>
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
            <NextLink
              href={boardNewPlanHref(projectId, NEXT_WAVE_BRIEF)}
              className={buttonClassName({ variant: 'glass' })}
            >
              Plan next wave
            </NextLink>
            {canOperate ? (
              <Button variant="solid" onClick={() => setCreating(true)}>
                <Plus aria-hidden="true" className="size-4" />
                New task
              </Button>
            ) : null}
          </div>
        }
      />
      {project ? <RunnerOfflineBanner project={project} /> : null}
      <BudgetExceededBanner projectId={projectId} />

      <section aria-label="Analytics" className="flex flex-col gap-3">
        <ProjectStats
          projectId={projectId}
          period={period}
          ranges={ranges}
          figures={figures}
        />
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <ThroughputCard period={period} ranges={ranges} runs={runs} />
          <WorkBreakdownCard period={period} figures={figures} />
        </div>
      </section>

      <RecentTasks projectId={projectId} runs={recent} />

      <OrchestratorSection
        projectId={projectId}
        project={project}
        open={orchestratorOpen}
        onOpenChange={(open) =>
          setParam(ORCHESTRATOR_PARAM, open ? 'open' : null)
        }
        fleet={fleet}
        graph={graph}
        activity={activity}
        queued={queue.data?.items.length}
        desktop={desktop}
        control={control}
        canOperate={canOperate}
      />

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
