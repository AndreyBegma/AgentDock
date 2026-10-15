'use client';

import {
  BOARD_CHANGED_EVENT,
  type BoardCardView,
  type BoardView,
} from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
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
import { BoardColumns } from '../../../../../components/board/board-view';
import {
  CardSheet,
  type TerminalAccess,
} from '../../../../../components/board/card-sheet';
import { NewCardDialog } from '../../../../../components/board/new-card-dialog';
import { useCardActions } from '../../../../../components/board/use-card-actions';
import { PageHeader } from '../../../../../components/page-header/page-header';
import { AsyncSection } from '../../../../../components/prerequisites/async-section';
import { RunnerOfflineBanner } from '../../../../../components/prerequisites/prerequisite-banner';
import { ReadinessBanner } from '../../../../../components/readiness/readiness-banner';
import { useLivePaused } from '../../../../../components/shell/live-status';
import { LiveStatusBadge } from '../../../../../components/shell/live-status-badge';
import { TerminalSheet } from '../../../../../components/terminal/terminal-sheet';
import { fetchBoard } from '../../../../../lib/board/actions';
import {
  cardByNumber,
  describeBoardError,
  isNotFound,
  parseCardParam,
} from '../../../../../lib/board/format';
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
  /** Bumped by a live push or a mutation; the board and the sheet depend on it. */
  const [version, setVersion] = useState(0);
  const [creating, setCreating] = useState(false);
  const [attaching, setAttaching] = useState<BoardCardView>();
  const [older, setOlder] = useState<BoardCardView[]>([]);
  const [olderHasMore, setOlderHasMore] = useState<boolean>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const live = useLivePaused();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useLive(`project:${projectId}`, (message) => {
    if (message.event !== BOARD_CHANGED_EVENT) return;
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

  const select = (number: number | undefined) => {
    const next = new URLSearchParams(params.toString());
    if (number === undefined) next.delete('card');
    else next.set('card', String(number));
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  };

  const actions = useCardActions({
    projectId,
    runnerName: project?.runnerName,
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
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <PageHeader
          className="mb-0"
          title="Board"
          description={
            view
              ? `${view.running} of ${view.settings.maxRunning} workers running`
              : undefined
          }
          actions={
            <>
              {live.status !== 'connected' ? <LiveStatusBadge /> : null}
              {canOperate ? (
                <Button variant="solid" onClick={() => setCreating(true)}>
                  New card
                </Button>
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

      <AsyncSection
        section={board}
        unavailable={{
          title: 'The board could not be loaded',
          stillWorks: 'Fleet, queue and history are still available.',
        }}
        empty={null}
        isEmpty={() => false}
      >
        {() =>
          view ? (
            <>
              <BoardColumns
                projectId={projectId}
                view={view}
                runnerName={project?.runnerName}
                canOperate={canOperate}
                canTerminal={canAttach}
                actions={actions}
                onOpen={(card) => select(card.number)}
                onOpenTerminal={setAttaching}
                onReload={reload}
              />
              {hasMoreOlder && lastCompleted?.completedAt ? (
                <div>
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
        <NewCardDialog
          projectId={projectId}
          open={creating}
          settings={board.data?.settings}
          onOpenChange={setCreating}
          onCreated={(number) => {
            reload();
            select(number);
          }}
        />
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
