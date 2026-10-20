'use client';

import {
  FLEET_LIVE_EVENT,
  type FleetGraph,
  type FleetView,
  type OrchestratorSettingsView,
  projectRoleAtLeast,
  type QueueView,
} from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { SheetContent, SheetRoot } from '@andrewbehma/glass-ui/sheet';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { CirclePlus } from 'lucide-react';
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
} from 'react';
import { BudgetExceededBanner } from '../../../../../components/budgets/exceeded-banner';
import { AsyncSection } from '../../../../../components/prerequisites/async-section';
import { RunnerOfflineBanner } from '../../../../../components/prerequisites/prerequisite-banner';
import { usePageActions } from '../../../../../components/shell/use-page-actions';
import { TerminalSheet } from '../../../../../components/terminal/terminal-sheet';
import type { TerminalTarget } from '../../../../../components/terminal/terminal-view';
import { api } from '../../../../../lib/api';
import { boardNewPlanHref } from '../../../../../lib/board/href';
import { useControl } from '../../../../../lib/control/use-control';
import {
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
import { allowedLabels } from '../../../../../lib/queue/format';
import { useSection } from '../../../../../lib/section/use-section';
import { slotSessionMessenger } from '../../../../../lib/session-message/actions';
import { useTabletUp } from '../../../../../lib/slot/use-wide';
import { useTerminalAvailable } from '../../../../../lib/terminal/use-terminal-available';
import { NewIssueDialog } from '../queue/new-issue-dialog';
import { useProjectDetail } from '../use-project-detail';
import { AgentCanvas, AgentList } from './agent-canvas';
import { AgentDock } from './agent-dock';
import { BoardErrorBanner } from './board-error-banner';
import { DependenciesPanel } from './dependencies-panel';
import { FirstProjectChecklist } from './first-project-checklist';
import { FleetHeader } from './fleet-header';
import { OrchestratorCard } from './orchestrator-card';
import { OrchestratorRow } from './orchestrator-row';
import { QuickActions } from './quick-actions';
import { SlotPanel } from './slot-panel';
import { SlotsView } from './slots-view';
import { StartOrchestratorDialog } from './start-dialog';
import { useControlReasons } from './use-control-reasons';
import { useDesktop } from './use-desktop';

/** Pushes arrive in bursts (one per projected batch); one refetch covers them. */
const REFETCH_DEBOUNCE_MS = 300;
/** Ages in the table are relative to now. */
const AGE_TICK_MS = 30_000;
const DEPENDENCIES_ID = 'fleet-dependencies';
const NEXT_WAVE_BRIEF = 'Plan the next wave of work for this project.';

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
  const tabletUp = useTabletUp();
  const detail = useProjectDetail(projectId);
  const project = detail.data;
  // The effective role only decides which buttons are drawn; the API checks it.
  const role = project?.role ?? 'viewer';
  const isAdmin = role === 'admin';
  const canOperate = projectRoleAtLeast(role, 'operator');

  // The capsule's `+` below `lg` (#521) opens what the header's button opens.
  usePageActions([
    {
      id: 'new-issue',
      label: 'New issue',
      icon: CirclePlus,
      onSelect: () => setCreating(true),
      operatorOnly: true,
    },
  ]);
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
  const orchestratorMessageReason = canOperate
    ? (reasons.message?.text ?? null)
    : 'Operators and admins can message the orchestrator.';

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

  /**
   * Nothing on the board and no orchestrator at work: the first-project
   * checklist stands in for the canvas, and its Start is the screen's one
   * solid button (#213).
   */
  const emptyFleet =
    (graph.data?.nodes.length ?? 0) <= 1 &&
    (fleet.data?.slots.length ?? 0) === 0;
  const showChecklist =
    emptyFleet &&
    orchestratorStatus !== undefined &&
    orchestratorStatus !== 'running' &&
    orchestratorStatus !== 'idle';

  const orchestratorCard = (view: FleetView) => (
    <OrchestratorCard
      fleet={view}
      projectId={projectId}
      control={control}
      canOperate={canOperate}
      isAdmin={isAdmin}
      settings={settings}
      reasons={reasons}
      showStart={!showChecklist}
      onStart={() => setStartOpen(true)}
      {...(onAttach ? { onAttach: () => onAttach(ORCHESTRATOR_KEY) } : {})}
    />
  );

  /** Nothing runs here yet: what is left, in order, then the card's facts. */
  const notRunning = (view: FleetView) => (
    <div className="flex flex-col gap-4">
      <FirstProjectChecklist
        projectId={projectId}
        runnerId={project?.runnerId}
        isAdmin={isAdmin}
        canOperate={canOperate}
        settings={settings}
        startReason={reasons.start}
        starting={control.busy('orchestrator.start')}
        onStart={() => setStartOpen(true)}
      />
      {orchestratorCard(view)}
    </div>
  );

  /** Running, but nothing to run: the queue is empty. */
  const queueEmpty = (
    <EmptyState
      title="The queue is empty"
      description={`${EMPTY_FLEET_DESCRIPTION} Nautelle does not create agents itself: queue an issue and the orchestrator dispatches it.`}
      action={
        <div className="flex flex-wrap items-center justify-center gap-3">
          {canOperate ? (
            // Glass: New issue in the header is the screen's solid.
            <Button variant="glass" onClick={() => setCreating(true)}>
              New issue
            </Button>
          ) : null}
          <Link
            href={boardNewPlanHref(projectId, NEXT_WAVE_BRIEF)}
            className="text-sm text-accent-ink underline"
          >
            Plan the next wave
          </Link>
        </div>
      }
    />
  );

  const emptyView = (view: FleetView) =>
    showChecklist ? notRunning(view) : queueEmpty;

  return (
    <div className="flex flex-col gap-4">
      <FleetHeader
        projectId={projectId}
        projectName={project?.displayName}
        orchestrator={orchestratorStatus}
        counts={counts}
        view={workspace.view}
        canOperate={canOperate}
        newIssuePrimary={!showChecklist}
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
      {fleet.data?.boardError ? (
        <BoardErrorBanner error={fleet.data.boardError} />
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
                <>
                  {showChecklist ? null : (
                    <OrchestratorRow
                      fleet={view}
                      selected={workspace.focus === ORCHESTRATOR_KEY}
                      onOpen={() => open(ORCHESTRATOR_KEY)}
                    />
                  )}
                  <SlotsView
                    projectId={projectId}
                    active={view.slots}
                    version={version}
                    nobodyYet={emptyView(view)}
                    focus={workspace.focus}
                    onSelect={open}
                  />
                </>
              ) : (
                <AsyncSection
                  section={graph}
                  unavailable={{
                    title: 'The agent tree could not be loaded',
                    stillWorks: 'The Slots view still lists every slot.',
                  }}
                  isEmpty={(g) => g.nodes.length <= 1}
                  empty={emptyView(view)}
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
                        orchestratorMessageReason={orchestratorMessageReason}
                        onOpen={open}
                        {...(onAttach ? { onAttach } : {})}
                      />
                    ) : (
                      <AgentList
                        graph={g}
                        focus={workspace.focus}
                        control={control}
                        canOperate={canOperate}
                        orchestratorMessageReason={orchestratorMessageReason}
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
                orchestratorMessageReason={orchestratorMessageReason}
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

        {/* The focused slot's panel: a column from `lg`, its own sheet below. */}
        {focusedSlot ? (
          <SlotPanel
            projectId={projectId}
            slot={focusedSlot}
            control={control}
            onClose={() => update(blur)}
            onOpenSlot={open}
          />
        ) : null}
      </div>

      <SheetRoot
        open={workspace.focus === ORCHESTRATOR_KEY && fleet.data !== undefined}
        onOpenChange={(isOpen) => {
          if (!isOpen) update(blur);
        }}
      >
        <SheetContent
          side={tabletUp === false ? 'bottom' : 'right'}
          title="Orchestrator"
        >
          {fleet.data ? orchestratorCard(fleet.data) : null}
        </SheetContent>
      </SheetRoot>

      {canOperate ? (
        <StartOrchestratorDialog
          control={control}
          isAdmin={isAdmin}
          settings={settings.data}
          open={startOpen}
          onOpenChange={setStartOpen}
          onStarted={() => setVersion((v) => v + 1)}
        />
      ) : null}

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
        backTo="Fleet"
        message={
          canOperate && attach?.target.kind === 'slot'
            ? { send: slotSessionMessenger(projectId, attach.target.slot) }
            : undefined
        }
      />
    </div>
  );
}
