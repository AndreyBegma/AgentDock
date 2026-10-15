'use client';

import type {
  BoardCardView,
  BoardPlanTaskView,
  BoardView,
} from '@agentdock/shared';
import { Board, type BoardColumn } from '@andrewbehma/glass-ui/board';
import { Button } from '@andrewbehma/glass-ui/button';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { MenuItem, MenuSeparator } from '@andrewbehma/glass-ui/menu';
import { toast } from '@andrewbehma/glass-ui/toast';
import { useRouter } from 'next/navigation';
import { type CSSProperties, useState } from 'react';
import { moveCard, runCard } from '../../lib/board/actions';
import {
  applyDrop,
  clampDropIndex,
  type DropDecision,
  type DropMove,
  decideDrop,
  moveRequest,
} from '../../lib/board/board-state';
import {
  type BoardFilter,
  isFiltering,
  matchesFilter,
  unfilteredIndex,
} from '../../lib/board/filter';
import {
  approveRunOffer,
  COLUMN_HINT,
  COLUMN_TITLE,
  canAccept,
  canDelete,
  canGiveFeedback,
  canMarkFinished,
  canRetry,
  canRun,
  canStop,
  columnsOf,
  describeBoardError,
  isSuggestion,
} from '../../lib/board/format';
import {
  boardItems,
  isPlanItem,
  type WorkBoardItem,
} from '../../lib/board/plan-tasks';
import { cardDesignHref } from '../../lib/design/href';
import { planHref } from '../../lib/planner/href';
import { boardColumnWidth, usePhone, visibleColumns } from './board-layout';
import { CardFace } from './card-face';
import { PlanTaskFace } from './plan-task-face';
import type { CardActions } from './use-card-actions';

type Asking = Extract<DropDecision, { kind: 'confirm-stop' | 'offer-run' }>;

/**
 * The Board (D7). It is controlled: a drop is checked with `boardMoveRule`,
 * shown at once, and sent; a refusal from the server rolls it back with a toast.
 * glass-ui's `Board` has no `canDrop`, so a drop that is not allowed is
 * declined here, in `onMove`.
 */
export function BoardColumns({
  projectId,
  view,
  planTasks,
  runnerName,
  canOperate,
  canTerminal,
  actions,
  filter,
  compact,
  onOpen,
  onOpenPlanTask,
  onOpenTerminal,
  onReload,
}: {
  projectId: string;
  view: BoardView;
  /** #270: read-only plan tasks, after the cards of their column (D4). */
  planTasks: readonly BoardPlanTaskView[];
  runnerName?: string | null;
  canOperate: boolean;
  canTerminal: boolean;
  actions: CardActions;
  /** C-29: what the toolbar hides; a hidden card is still in the column. */
  filter: BoardFilter;
  compact: boolean;
  onOpen: (card: BoardCardView) => void;
  onOpenPlanTask: (task: BoardPlanTaskView) => void;
  onOpenTerminal: (card: BoardCardView) => void;
  onReload: () => void;
}) {
  const router = useRouter();
  // The drop shown before the server answers.
  const [optimistic, setOptimistic] = useState<BoardView>();
  const [asking, setAsking] = useState<Asking>();
  const [busy, setBusy] = useState(false);
  const shown = optimistic ?? view;

  const phone = usePhone();

  const items = boardItems(shown, planTasks);
  const filtering = isFiltering(filter);
  const allColumns: BoardColumn<WorkBoardItem>[] = columnsOf(shown).map((c) => {
    const all = items.get(c.column) ?? [];
    const cards = filtering
      ? all.filter((item) => matchesFilter(item, filter))
      : all;
    return {
      id: c.column,
      title: COLUMN_TITLE[c.column],
      // `shown/total` while a filter hides some of the column.
      header: filtering ? (
        <span className="text-xs text-ink-3 tabular-nums">of {all.length}</span>
      ) : undefined,
      cards,
      footer:
        all.length === 0 ? (
          <p className="px-1 text-xs text-ink-3">{COLUMN_HINT[c.column]}</p>
        ) : cards.length === 0 ? (
          <p className="px-1 text-xs text-ink-3">No cards match.</p>
        ) : c.column === 'inbox' && canOperate && !filtering ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={actions.busy || busy}
            onClick={() => actions.askDismissAll(c.cards.length)}
          >
            Dismiss all
          </Button>
        ) : undefined,
    };
  });

  const columns = visibleColumns(allColumns, phone);

  const send = async (
    move: DropMove,
    number: number,
    options: { stopWorker?: boolean; run?: boolean } = {},
  ) => {
    setOptimistic(applyDrop(view, move));
    setBusy(true);
    try {
      await moveCard(
        projectId,
        number,
        moveRequest(move, options.stopWorker === true),
      );
      if (options.run) await runCard(projectId, number);
    } catch (err) {
      toast.error(describeBoardError(err, runnerName));
    } finally {
      // Server truth either way: on a refusal this is the rollback.
      setOptimistic(undefined);
      setBusy(false);
      onReload();
    }
  };

  /** Under a filter the board reports an index among the visible cards. */
  const withFullIndex = (dropped: DropMove): DropMove => {
    if (!filtering) return dropped;
    const full = view.columns
      .find((c) => c.column === dropped.toColumnId)
      ?.cards.filter((c) => c.id !== dropped.id)
      .map((c) => c.id);
    const visible = allColumns
      .find((c) => c.id === dropped.toColumnId)
      ?.cards.filter((c) => c.id !== dropped.id)
      .map((c) => c.id);
    if (!full || !visible) return dropped;
    return { ...dropped, index: unfilteredIndex(full, visible, dropped.index) };
  };

  const onMove = (dropped: DropMove) => {
    if (!canOperate) {
      toast.error('Only operators can move cards.');
      return;
    }
    const move = clampDropIndex(view, withFullIndex(dropped));
    const decision = decideDrop(view, move);
    switch (decision.kind) {
      case 'ignore':
        return;
      case 'refused':
        toast.error(decision.text);
        return;
      case 'confirm-stop':
      case 'offer-run':
        setAsking(decision);
        return;
      case 'move':
        void send(move, decision.card.number);
    }
  };

  const answerRun = (run: boolean) => {
    if (asking?.kind !== 'offer-run') return;
    const { move, card } = asking;
    setAsking(undefined);
    void send(move, card.number, { run });
  };

  const confirmStop = () => {
    if (asking?.kind !== 'confirm-stop') return;
    const { move, card } = asking;
    setAsking(undefined);
    void send(move, card.number, { stopWorker: true });
  };

  return (
    <>
      {/* Fills the height the page leaves; glass-ui's `Board` scrolls each column in it. */}
      <div
        className="flex min-h-0 flex-1 flex-col"
        style={
          {
            '--board-column': boardColumnWidth(columns.length),
          } as CSSProperties
        }
      >
        <Board<WorkBoardItem>
          className="flex-1 pb-0.5"
          aria-label="Project board"
          columns={columns}
          onMove={onMove}
          renderCard={(item) =>
            isPlanItem(item) ? (
              <PlanTaskFace task={item.planTask} onOpen={onOpenPlanTask} />
            ) : (
              <CardFace
                projectId={projectId}
                card={item.card}
                canOperate={canOperate}
                compact={compact}
                onOpen={onOpen}
              />
            )
          }
          renderCardMenu={(item) => {
            if (isPlanItem(item)) {
              const task = item.planTask;
              return (
                <>
                  <MenuSeparator />
                  <MenuItem onSelect={() => onOpenPlanTask(task)}>
                    Open
                  </MenuItem>
                  <MenuItem
                    onSelect={() =>
                      router.push(planHref(projectId, task.planId, task.key))
                    }
                  >
                    Open in Planner
                  </MenuItem>
                </>
              );
            }
            const card = item.card;
            if (isSuggestion(card)) {
              return (
                <>
                  <MenuSeparator />
                  <MenuItem onSelect={() => onOpen(card)}>Open</MenuItem>
                  {canOperate ? (
                    <>
                      <MenuItem
                        disabled={actions.busy || busy}
                        onSelect={() => void actions.acceptSuggestion(card)}
                      >
                        Accept
                      </MenuItem>
                      <MenuItem onSelect={() => onOpen(card)}>
                        Edit & accept…
                      </MenuItem>
                      <MenuItem
                        tone="danger"
                        disabled={actions.busy || busy}
                        onSelect={() => void actions.dismiss(card)}
                      >
                        Dismiss
                      </MenuItem>
                    </>
                  ) : null}
                </>
              );
            }
            return (
              <>
                <MenuSeparator />
                <MenuItem onSelect={() => onOpen(card)}>Open</MenuItem>
                {canOperate && (canRun(card) || canRetry(card)) ? (
                  <MenuItem
                    disabled={actions.busy || busy}
                    onSelect={() => actions.run(card)}
                  >
                    {canRetry(card) ? 'Run again' : 'Run'}
                  </MenuItem>
                ) : null}
                {canOperate && approveRunOffer(card) ? (
                  <MenuItem
                    disabled={!approveRunOffer(card)?.enabled}
                    onSelect={() =>
                      router.push(cardDesignHref(projectId, card.number))
                    }
                  >
                    Approve & run
                  </MenuItem>
                ) : null}
                {canOperate && canMarkFinished(card) ? (
                  <MenuItem onSelect={() => actions.markFinished(card)}>
                    Mark finished
                  </MenuItem>
                ) : null}
                {canOperate && canGiveFeedback(card) ? (
                  <MenuItem onSelect={() => onOpen(card)}>Feedback…</MenuItem>
                ) : null}
                {canOperate && canAccept(card) ? (
                  <MenuItem onSelect={() => actions.accept(card)}>
                    Accept
                  </MenuItem>
                ) : null}
                {canTerminal && card.round !== null ? (
                  <MenuItem onSelect={() => onOpenTerminal(card)}>
                    Open terminal
                  </MenuItem>
                ) : null}
                {canOperate && canStop(card) ? (
                  <MenuItem
                    tone="danger"
                    onSelect={() => actions.askStop(card)}
                  >
                    Stop worker
                  </MenuItem>
                ) : null}
                {canOperate && canDelete(card) ? (
                  <MenuItem
                    tone="danger"
                    onSelect={() => actions.askDelete(card)}
                  >
                    Delete
                  </MenuItem>
                ) : null}
              </>
            );
          }}
        />
      </div>

      <DialogRoot
        open={asking?.kind === 'offer-run'}
        onOpenChange={(open) => {
          if (!open) setAsking(undefined);
        }}
      >
        <DialogContent
          title="Run the worker?"
          description={`${asking?.card.label ?? 'The card'} is moving to In progress. A drag never starts a worker by itself.`}
          footer={
            <>
              <Button variant="glass" onClick={() => setAsking(undefined)}>
                Cancel
              </Button>
              <Button variant="glass" onClick={() => answerRun(false)}>
                Just move
              </Button>
              <Button onClick={() => answerRun(true)}>Run</Button>
            </>
          }
        >
          <p className="text-sm text-ink-2">
            Run starts a dedicated Claude Code worker in its own worktree. “Just
            move” only changes the column.
          </p>
        </DialogContent>
      </DialogRoot>

      <ConfirmDialog
        open={asking?.kind === 'confirm-stop'}
        onOpenChange={(open) => {
          if (!open) setAsking(undefined);
        }}
        title={`Stop the worker of ${asking?.card.label ?? 'the card'}?`}
        consequence="Moving the card out of In progress kills its tmux session. What it committed stays in the worktree."
        verb="Stop worker and move"
        tone="danger"
        onConfirm={confirmStop}
      />
    </>
  );
}
