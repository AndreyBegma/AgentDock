'use client';

import {
  BOARD_CHANGED_EVENT,
  type BoardCardView,
  type BoardPlanTaskView,
  type BoardView,
  PLANNER_LIVE_EVENT,
  type PlanSummary,
  QUEUE_LIVE_EVENT,
} from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@andrewbehma/glass-ui/segmented-control';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { toast } from '@andrewbehma/glass-ui/toast';
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
import {
  BoardToolbar,
  type Density,
} from '../../../../../components/board/board-toolbar';
import { BoardColumns } from '../../../../../components/board/board-view';
import {
  CardSheet,
  type TerminalAccess,
} from '../../../../../components/board/card-sheet';
import { DraftsStrip } from '../../../../../components/board/drafts-strip';
import { NewCardDialog } from '../../../../../components/board/new-card-dialog';
import { PlanPanel } from '../../../../../components/board/plan-panel';
import { PlanTaskSheet } from '../../../../../components/board/plan-task-sheet';
import { useCardActions } from '../../../../../components/board/use-card-actions';
import { PageHeader } from '../../../../../components/page-header/page-header';
import { AsyncSection } from '../../../../../components/prerequisites/async-section';
import { RunnerOfflineBanner } from '../../../../../components/prerequisites/prerequisite-banner';
import { ReadinessBanner } from '../../../../../components/readiness/readiness-banner';
import { useLivePaused } from '../../../../../components/shell/live-status';
import { LiveStatusBadge } from '../../../../../components/shell/live-status-badge';
import { useCurrentUser } from '../../../../../components/shell/user-context';
import { TerminalSheet } from '../../../../../components/terminal/terminal-sheet';
import { fetchBoard } from '../../../../../lib/board/actions';
import {
  boardFilterCodec,
  boardMeta,
  isFiltering,
  matchesFilter,
} from '../../../../../lib/board/filter';
import {
  cardByNumber,
  describeBoardError,
  isNotFound,
  parseCardParam,
} from '../../../../../lib/board/format';
import {
  boardItems,
  fetchPlanTasks,
  findPlanTask,
  parsePlanTaskParam,
} from '../../../../../lib/board/plan-tasks';
import { useUrlFilters } from '../../../../../lib/filters/use-url-filters';
import { useLive } from '../../../../../lib/live/use-live';
import { useReadiness } from '../../../../../lib/readiness/use-readiness';
import { useSection } from '../../../../../lib/section/use-section';
import { useTerminalAvailable } from '../../../../../lib/terminal/use-terminal-available';
import { useProjectDetail } from '../use-project-detail';

/** Pushes arrive in bursts (one per round change); one refetch covers them. */
const REFETCH_DEBOUNCE_MS = 300;

export default function BoardPage() {
  // `useSearchParams` needs a boundary for the static shell.
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <BoardScreen />
    </Suspense>
  );
}

function BoardScreen() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selected = parseCardParam(params.get('card'));
  const selectedPlanTask = parsePlanTaskParam(
    params.get('plan'),
    params.get('task'),
  );
  // #337: the New Card intake (`?intake=`) and the New Plan panel
  // (`?newPlan=1`, then `?planPanel=`) live in the URL, so a reload or a
  // Drafts Resume lands on them.
  const intakeId = params.get('intake') ?? undefined;
  const planPanelId = params.get('planPanel') ?? undefined;
  const planPanelOpen = planPanelId !== undefined || params.has('newPlan');
  const user = useCurrentUser();
  /** Bumped by a live push or a mutation; the board and the sheet depend on it. */
  const [version, setVersion] = useState(0);
  const [creating, setCreating] = useState(false);
  const [attaching, setAttaching] = useState<BoardCardView>();
  const [older, setOlder] = useState<BoardCardView[]>([]);
  const [olderHasMore, setOlderHasMore] = useState<boolean>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [density, setDensity] = useState<Density>('comfortable');
  const url = useUrlFilters(boardFilterCodec);
  const live = useLivePaused();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useLive(`project:${projectId}`, (message) => {
    // D14: a plan task moves with its plan (planner) and its issue (queue).
    if (
      message.event !== BOARD_CHANGED_EVENT &&
      message.event !== PLANNER_LIVE_EVENT &&
      message.event !== QUEUE_LIVE_EVENT
    ) {
      return;
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(reload, REFETCH_DEBOUNCE_MS);
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  const project = useProjectDetail(projectId).data;
  const role = project?.role ?? 'viewer';
  const canOperate = role !== 'viewer';
  const isAdmin = role === 'admin';
  const canAttach = useTerminalAvailable(project?.runnerId, isAdmin);

  const board = useSection(() => fetchBoard(projectId), [projectId, version]);
  const planTasks = useSection(
    () => fetchPlanTasks(projectId),
    [projectId, version],
  );
  const planTaskItems: readonly BoardPlanTaskView[] =
    planTasks.data?.items ?? [];
  const readiness = useReadiness(projectId);

  // Older Completed pages are fetched by hand; a fresh first page resets them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the board reloads → start over
  useEffect(() => {
    setOlder([]);
    setOlderHasMore(undefined);
  }, [board.data]);

  const view: BoardView | undefined = useMemo(() => {
    const data = board.data;
    if (!data || older.length === 0) return data;
    return {
      ...data,
      columns: data.columns.map((c) =>
        c.column === 'completed' ? { ...c, cards: [...c.cards, ...older] } : c,
      ),
    };
  }, [board.data, older]);

  // The header's figures follow the filter: what is running, what waits on you.
  const meta = useMemo(() => {
    if (!view) return undefined;
    const items = [...boardItems(view, planTaskItems).values()]
      .flat()
      .filter((item) => matchesFilter(item, url.filters));
    return { ...boardMeta(items), shown: items.length };
  }, [view, planTaskItems, url.filters]);

  const completed = view?.columns.find((c) => c.column === 'completed');
  const lastCompleted = completed?.cards.at(-1);
  const hasMoreOlder =
    olderHasMore ??
    board.data?.columns.find((c) => c.column === 'completed')?.hasMore ??
    false;

  const loadOlder = async () => {
    const before = lastCompleted?.completedAt;
    if (!before) return;
    setLoadingOlder(true);
    try {
      const page = await fetchBoard(projectId, before);
      const next = page.columns.find((c) => c.column === 'completed');
      setOlder((current) => [...current, ...(next?.cards ?? [])]);
      setOlderHasMore(next?.hasMore ?? false);
    } catch (err) {
      toast.error(describeBoardError(err));
    } finally {
      setLoadingOlder(false);
    }
  };

  /** Sets (a string) or removes (undefined) each named search param. */
  const setParams = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  };

  const select = (number: number | undefined) =>
    setParams({ card: number === undefined ? undefined : String(number) });

  const closePlanPanel = () =>
    setParams({ newPlan: undefined, planPanel: undefined, brief: undefined });

  const resumeDraft = (plan: PlanSummary) =>
    plan.mode === 'card'
      ? setParams({ intake: plan.id })
      : setParams({ newPlan: undefined, planPanel: plan.id });

  const selectPlanTask = (task: BoardPlanTaskView | undefined) => {
    const next = new URLSearchParams(params.toString());
    if (!task) {
      next.delete('plan');
      next.delete('task');
    } else {
      next.set('plan', task.planId);
      next.set('task', task.key);
    }
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  };

  const actions = useCardActions({
    projectId,
    runnerName: project?.runnerName,
    runnerCommands: project?.runnerCommands,
    onChanged: reload,
    onDeleted: (card) => {
      if (card.number === selected) select(undefined);
    },
  });

  const selectedCard =
    view && selected !== undefined ? cardByNumber(view, selected) : undefined;

  const terminal: TerminalAccess = canAttach
    ? {
        state: 'available',
        open: () => selectedCard && setAttaching(selectedCard),
      }
    : {
        state: 'disabled',
        reason: isAdmin
          ? 'The runner does not offer terminal attach.'
          : 'Only administrators can open a terminal.',
      };

  if (board.data === undefined && isNotFound(board.error)) {
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

  return (
    // The shell gives the page the screen's height; the board takes what the header and toolbar leave.
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-col gap-3">
        <PageHeader
          className="mb-0"
          title="Work"
          description={
            view && meta
              ? `${view.running} of ${view.settings.maxRunning} workers running · ${meta.shown} ${meta.shown === 1 ? 'card' : 'cards'}${isFiltering(url.filters) ? ' shown' : ''} · ${meta.running} running · ${meta.waiting} waiting on you`
              : undefined
          }
          actions={
            <>
              {live.status !== 'connected' ? <LiveStatusBadge /> : null}
              <SegmentedControl role="group" aria-label="View">
                <SegmentedControlItem active={false} layoutId="work-view">
                  <Link
                    href={`/work?projectId=${encodeURIComponent(projectId)}`}
                    className="block w-full min-w-16 px-3 py-1.5 text-center text-sm whitespace-nowrap"
                  >
                    List
                  </Link>
                </SegmentedControlItem>
                <SegmentedControlItem active layoutId="work-view">
                  <button
                    type="button"
                    aria-pressed
                    className="w-full min-w-16 px-3 py-1.5 text-sm whitespace-nowrap"
                  >
                    Board
                  </button>
                </SegmentedControlItem>
              </SegmentedControl>
              {canOperate ? (
                <>
                  <Button
                    variant="glass"
                    onClick={() => setParams({ newPlan: '1' })}
                  >
                    New plan
                  </Button>
                  <Button variant="solid" onClick={() => setCreating(true)}>
                    New card
                  </Button>
                </>
              ) : null}
            </>
          }
        />
        {project ? <RunnerOfflineBanner project={project} /> : null}
        <ReadinessBanner
          projectId={projectId}
          readiness={readiness}
          captureOn={board.data?.settings.captureEnabled ?? false}
        />
      </div>

      {canOperate ? (
        // Fixed height above the board: the columns scroll, the page does not.
        <div className="shrink-0">
          <DraftsStrip
            projectId={projectId}
            userId={user.id}
            version={version}
            onResume={resumeDraft}
            onDiscarded={(plan) => {
              if (plan.id === intakeId) setParams({ intake: undefined });
              if (plan.id === planPanelId) closePlanPanel();
            }}
          />
        </div>
      ) : null}

      <BoardToolbar url={url} density={density} onDensityChange={setDensity} />

      <AsyncSection
        section={board}
        unavailable={{
          title: 'The board could not be loaded',
          stillWorks: 'Fleet, queue and history are still available.',
        }}
        empty={null}
        isEmpty={() => false}
        // The board's height chain runs through this wrapper (#384).
        className="min-h-0 flex-1"
      >
        {() =>
          view ? (
            <>
              <BoardColumns
                projectId={projectId}
                view={view}
                planTasks={planTaskItems}
                runnerName={project?.runnerName}
                canOperate={canOperate}
                canTerminal={canAttach}
                actions={actions}
                filter={url.filters}
                compact={density === 'compact'}
                onOpen={(card) => select(card.number)}
                onOpenPlanTask={selectPlanTask}
                onOpenTerminal={setAttaching}
                onReload={reload}
              />
              {hasMoreOlder && lastCompleted?.completedAt ? (
                <div className="shrink-0">
                  <Button
                    variant="glass"
                    disabled={loadingOlder}
                    onClick={() => void loadOlder()}
                  >
                    {loadingOlder ? 'Loading…' : 'Show older completed cards'}
                  </Button>
                </div>
              ) : null}
            </>
          ) : null
        }
      </AsyncSection>

      {canOperate ? (
        <>
          <NewCardDialog
            projectId={projectId}
            project={project}
            open={creating || intakeId !== undefined}
            planId={intakeId}
            board={board.data}
            onOpenChange={(open) => {
              setCreating(open);
              // Closing keeps the intake as a draft (D2).
              if (!open && intakeId) setParams({ intake: undefined });
            }}
            onStarted={(planId) => {
              setCreating(false);
              setParams({ intake: planId });
              reload();
            }}
            onCreated={(number) => {
              setCreating(false);
              setParams({ intake: undefined, card: String(number) });
            }}
          />
          <PlanPanel
            projectId={projectId}
            project={project}
            open={planPanelOpen}
            planId={planPanelId}
            initialBrief={params.get('brief') ?? ''}
            userId={user.id}
            onOpenChange={(open) => {
              if (!open) closePlanPanel();
            }}
            onStarted={(planId) => {
              setParams({
                newPlan: undefined,
                brief: undefined,
                planPanel: planId,
              });
              reload();
            }}
            onCardsCreated={(created) => {
              toast.success(
                created.cards.length === 1
                  ? `${created.cards[0]?.label} is in Todo.`
                  : `${created.cards.length} cards are in Todo.`,
              );
              closePlanPanel();
              reload();
            }}
          />
        </>
      ) : null}

      <CardSheet
        projectId={projectId}
        number={selected}
        title={selectedCard?.title}
        version={version}
        canOperate={canOperate}
        actions={actions}
        terminal={terminal}
        onChanged={reload}
        onClose={() => select(undefined)}
      />

      <PlanTaskSheet
        projectId={projectId}
        open={selectedPlanTask !== undefined}
        task={
          selectedPlanTask
            ? findPlanTask(
                planTaskItems,
                selectedPlanTask.planId,
                selectedPlanTask.key,
              )
            : undefined
        }
        loading={planTasks.data === undefined && planTasks.error === undefined}
        onClose={() => selectPlanTask(undefined)}
      />

      {actions.dialogs}

      <TerminalSheet
        projectId={projectId}
        target={attaching ? { kind: 'card', cardId: attaching.id } : undefined}
        title={attaching ? `${attaching.label} ${attaching.title}` : 'Card'}
        onClose={() => setAttaching(undefined)}
      />
    </div>
  );
}
