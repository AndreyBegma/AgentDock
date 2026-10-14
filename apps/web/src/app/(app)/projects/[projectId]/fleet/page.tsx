'use client';

import {
  FLEET_LIVE_EVENT,
  type FleetGraph,
  type FleetView,
  type OrchestratorSettingsView,
  projectRoleAtLeast,
  type QueueView,
} from '@agentdock/shared';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { SheetContent, SheetRoot } from '@andrewbehma/glass-ui/sheet';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import Link from 'next/link';
import {
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
} from 'next/navigation';
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { BudgetExceededBanner } from '../../../../../components/budgets/exceeded-banner';
import { AsyncSection } from '../../../../../components/prerequisites/async-section';
import { RunnerOfflineBanner } from '../../../../../components/prerequisites/prerequisite-banner';
import { TerminalSheet } from '../../../../../components/terminal/terminal-sheet';
import type { TerminalTarget } from '../../../../../components/terminal/terminal-view';
import { api } from '../../../../../lib/api';
import { useControl } from '../../../../../lib/control/use-control';
import {
  boardErrorView,
  EMPTY_FLEET_DESCRIPTION,
  isNotFound,
} from '../../../../../lib/fleet/format';
import { fleetCounts, liveSlots } from '../../../../../lib/fleet/graph';
import {
  blur,
  closeAll,
  closeSlot,
  ORCHESTRATOR_KEY,
  openSlot,
  parseWorkspace,
  setView,
  toSearch,
  type WorkspaceState,
} from '../../../../../lib/fleet/workspace-url';
import { useLive } from '../../../../../lib/live/use-live';
import { plannerBriefHref } from '../../../../../lib/planner/href';
import { allowedLabels } from '../../../../../lib/queue/format';
import { useSection } from '../../../../../lib/section/use-section';
import { useTerminalAvailable } from '../../../../../lib/terminal/use-terminal-available';
import { NewIssueDialog } from '../queue/new-issue-dialog';
import { useProjectDetail } from '../use-project-detail';
import { AgentCanvas, AgentList } from './agent-canvas';
import { AgentDock } from './agent-dock';
import { DependenciesPanel } from './dependencies-panel';
import { FleetHeader } from './fleet-header';
import { OrchestratorCard } from './orchestrator-card';
import { QuickActions } from './quick-actions';
import { SlotSheet } from './slot-sheet';
import { SlotsView } from './slots-view';
import { useControlReasons } from './use-control-reasons';

/** Pushes arrive in bursts (one per projected batch); one refetch covers them. */
const REFETCH_DEBOUNCE_MS = 300;
/** Ages in the table are relative to now. */
const AGE_TICK_MS = 30_000;
/** Where the canvas is drawn; below it a phone gets the list (and the panel a sheet). */
const DESKTOP_QUERY = '(min-width: 1024px)';
const DEPENDENCIES_ID = 'fleet-dependencies';
const NEXT_WAVE_BRIEF = 'Plan the next wave of work for this project.';

function subscribeDesktop(onChange: () => void) {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** True at the canvas's width. False on the server: the first paint is the list. */
function useDesktop(): boolean {
  return useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => false,
  );
}

export default function FleetPage() {
  // `useSearchParams` needs a boundary, or the route cannot prerender its shell.
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <FleetWorkspace />
    </Suspense>
  );
}

function FleetWorkspace() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const workspace = useMemo(() => parseWorkspace(searchParams), [searchParams]);
  const update = useCallback(
    (next: (state: WorkspaceState) => WorkspaceState) => {
      const search = toSearch(next(workspace), searchParams.entries());
      router.replace(`${pathname}${search}`, { scroll: false });
    },
    [workspace, searchParams, router, pathname],
  );

  /** Bumped by a live push; the fleet and the graph depend on it. */
  const [version, setVersion] = useState(0);
  const [, setNow] = useState(0);
  const [startOpen, setStartOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  /** Remounting the canvas fits it to view again. */
  const [fitKey, setFitKey] = useState(0);
  const [attach, setAttach] = useState<{
    target: TerminalTarget;
    title: string;
  }>();

  const desktop = useDesktop();
  const detail = useProjectDetail(projectId);
  const project = detail.data;
  // The effective role only decides which buttons are drawn; the API checks it.
  const role = project?.role ?? 'viewer';
  const isAdmin = role === 'admin';
  const canOperate = projectRoleAtLeast(role, 'operator');
  const control = useControl(projectId, isAdmin);
  const canAttach = useTerminalAvailable(project?.runnerId, isAdmin);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useLive(`project:${projectId}`, (message) => {
    // Slots, checkpoints and the conversation all arrive on the fleet event.
    if (message.event !== FLEET_LIVE_EVENT) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setVersion((v) => v + 1),
      REFETCH_DEBOUNCE_MS,
    );
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    const id = setInterval(() => setNow((n) => n + 1), AGE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const fleet = useSection(
    () => api<FleetView>(`/projects/${projectId}/fleet`),
    [projectId, version],
  );
  const graph = useSection(
    () => api<FleetGraph>(`/projects/${projectId}/fleet/graph`),
    [projectId, version],
  );
  const settings = useSection(
    () =>
      api<OrchestratorSettingsView>(
        `/projects/${projectId}/orchestrator/settings`,
      ),
    [projectId],
  );
  // The new-issue dialog's label choices; asked for only once it opens.
  const queue = useSection<QueueView | undefined>(
    () =>
      creating
        ? api<QueueView>(`/projects/${projectId}/queue?include=open`)
        : Promise.resolve(undefined),
    [projectId, creating],
  );
  const orchestratorStatus = fleet.data?.orchestrator.status;
  const reasons = useControlReasons({
    projectId,
    isAdmin,
    project,
    settings,
    orchestrator: orchestratorStatus,
  });

  const counts = useMemo(
    () => (graph.data ? fleetCounts(graph.data) : undefined),
    [graph.data],
  );

  const open = (key: string) => update((s) => openSlot(s, key));
  const onAttach = canAttach
    ? (key: string) =>
        setAttach(
          key === ORCHESTRATOR_KEY
            ? { target: { kind: 'orchestrator' }, title: 'Orchestrator' }
            : { target: { kind: 'slot', slot: key }, title: key },
        )
    : undefined;
  const focusedSlot =
    workspace.focus !== null && workspace.focus !== ORCHESTRATOR_KEY
      ? workspace.focus
      : null;

  if (fleet.data === undefined && isNotFound(fleet.error)) {
    return (
      <EmptyState
        title="Project not found"
        description="It was removed, or you are not a member of it."
        action={
          <Link href="/projects" className="text-sm text-accent-ink underline">
            Open Projects
          </Link>
        }
      />
    );
  }

  const newIssueAction = canOperate ? (
    <Button variant="solid" onClick={() => setCreating(true)}>
      New issue
    </Button>
  ) : null;

  const orchestratorCard = (view: FleetView) => (
    <OrchestratorCard
      fleet={view}
      projectId={projectId}
      control={control}
      canOperate={canOperate}
      isAdmin={isAdmin}
      settings={settings}
      reasons={reasons}
      startOpen={startOpen}
      onStartOpenChange={setStartOpen}
      {...(onAttach ? { onAttach: () => onAttach(ORCHESTRATOR_KEY) } : {})}
    />
  );

  /** The orchestrator is not running: say why nothing moves, and how to start it. */
  const notRunning = (view: FleetView) => (
    <div className="flex flex-col gap-4">
      <EmptyState
        title="The orchestrator is not running"
        description="AgentDock does not create agents itself: the orchestrator reads the queue and dispatches a slot per issue. Start it to put the queue to work."
        action={
          canOperate && reasons.start === null ? (
            <Button variant="solid" onClick={() => setStartOpen(true)}>
              Start the orchestrator
            </Button>
          ) : null
        }
      />
      {orchestratorCard(view)}
    </div>
  );

  /** Running, but nothing to run: the queue is empty. */
  const queueEmpty = (
    <EmptyState
      title="The queue is empty"
      description={`${EMPTY_FLEET_DESCRIPTION} AgentDock does not create agents itself: queue an issue and the orchestrator dispatches it.`}
      action={
        <div className="flex flex-wrap items-center justify-center gap-3">
          {newIssueAction}
          <Link
            href={plannerBriefHref(projectId, NEXT_WAVE_BRIEF)}
            className="text-sm text-accent-ink underline"
          >
            Plan the next wave
          </Link>
        </div>
      }
    />
  );

  const boardIssue = fleet.data?.boardError
    ? boardErrorView(fleet.data.boardError)
    : null;

  return (
    <div className="flex flex-col gap-4">
      <FleetHeader
        projectId={projectId}
        title={project?.displayName ?? 'Fleet'}
        orchestrator={orchestratorStatus}
        counts={counts}
        view={workspace.view}
        canOperate={canOperate}
        onNewIssue={() => setCreating(true)}
        {...(desktop &&
        workspace.view === 'canvas' &&
        (graph.data?.nodes.length ?? 0) > 1
          ? { onFit: () => setFitKey((k) => k + 1) }
          : {})}
        onViewChange={(view) => update((s) => setView(s, view))}
      />
      {project ? <RunnerOfflineBanner project={project} /> : null}
      <BudgetExceededBanner projectId={projectId} />
      {boardIssue ? (
        <Banner
          tone="warn"
          title={boardIssue.title}
          action={
            <Button
              variant="glass"
              size="sm"
              onClick={() => open(ORCHESTRATOR_KEY)}
            >
              Show detail
            </Button>
          }
        />
      ) : null}

      {/* A row: the workspace, then the agent panel as its last child. */}
      <div className="flex min-w-0 items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <AsyncSection
            section={fleet}
            unavailable={{
              title: 'The fleet could not be loaded',
              stillWorks: 'The rest of the project is still available.',
            }}
            empty={null}
            isEmpty={() => false}
            skeleton={<Skeleton className="h-96 w-full" />}
          >
            {(view) =>
              workspace.view === 'list' ? (
                <SlotsView
                  projectId={projectId}
                  active={view.slots}
                  version={version}
                  nobodyYet={
                    view.orchestrator.status === 'absent'
                      ? notRunning(view)
                      : queueEmpty
                  }
                  onSelect={open}
                />
              ) : (
                <AsyncSection
                  section={graph}
                  unavailable={{
                    title: 'The agent tree could not be loaded',
                    stillWorks:
                      'The table view (View → All slots) still lists every slot.',
                  }}
                  isEmpty={(g) => g.nodes.length <= 1}
                  empty={
                    view.orchestrator.status === 'absent'
                      ? notRunning(view)
                      : queueEmpty
                  }
                  skeleton={<Skeleton className="h-96 w-full" />}
                >
                  {(g) =>
                    desktop ? (
                      <AgentCanvas
                        key={fitKey}
                        graph={g}
                        focus={workspace.focus}
                        control={control}
                        canOperate={canOperate}
                        onOpen={open}
                        {...(onAttach ? { onAttach } : {})}
                      />
                    ) : (
                      <AgentList
                        graph={g}
                        focus={workspace.focus}
                        control={control}
                        canOperate={canOperate}
                        onOpen={open}
                        {...(onAttach ? { onAttach } : {})}
                      />
                    )
                  }
                </AsyncSection>
              )
            }
          </AsyncSection>

          {graph.data && graph.data.nodes.length > 1 ? (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
              <DependenciesPanel graph={graph.data} id={DEPENDENCIES_ID} />
              <QuickActions
                control={control}
                canOperate={canOperate}
                orchestrator={orchestratorStatus ?? 'unknown'}
                reasons={reasons}
                liveSlots={liveSlots(graph.data)}
                focusedSlot={focusedSlot}
                hasOpen={workspace.open.length > 0}
                onNewIssue={() => setCreating(true)}
                {...(onAttach ? { onAttach } : {})}
                onViewDependencies={() =>
                  document
                    .getElementById(DEPENDENCIES_ID)
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }
                onCollapseAll={() => update(closeAll)}
              />
            </div>
          ) : null}

          {graph.data && workspace.open.length > 0 ? (
            <AgentDock
              graph={graph.data}
              open={workspace.open}
              focus={workspace.focus}
              running={counts?.running ?? 0}
              onSelect={open}
              onClose={(slot) => update((s) => closeSlot(s, slot))}
            />
          ) : null}
        </div>

        {/* The focused slot's panel. Today's sheet until i160-panel's SlotPanel lands. */}
        <SlotSheet
          projectId={projectId}
          name={focusedSlot ?? undefined}
          version={version}
          control={control}
          canOperate={canOperate}
          onClose={() => update(blur)}
          {...(onAttach ? { onAttach } : {})}
        />
      </div>

      <SheetRoot
        open={workspace.focus === ORCHESTRATOR_KEY && fleet.data !== undefined}
        onOpenChange={(isOpen) => {
          if (!isOpen) update(blur);
        }}
      >
        <SheetContent side={desktop ? 'right' : 'bottom'} title="Orchestrator">
          {fleet.data ? orchestratorCard(fleet.data) : null}
        </SheetContent>
      </SheetRoot>

      {canOperate ? (
        <NewIssueDialog
          projectId={projectId}
          open={creating}
          labelChoices={allowedLabels(queue.data)}
          {...(project ? { runnerName: project.runnerName } : {})}
          onOpenChange={setCreating}
          onCreated={() => setVersion((v) => v + 1)}
        />
      ) : null}

      <TerminalSheet
        projectId={projectId}
        target={attach?.target}
        title={attach?.title ?? ''}
        onClose={() => setAttach(undefined)}
      />
    </div>
  );
}
