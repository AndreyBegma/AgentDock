'use client';

import type { BoardCardView, BoardView } from '@agentdock/shared';
import { Board, type BoardColumn } from '@andrewbehma/glass-ui/board';
import { Button } from '@andrewbehma/glass-ui/button';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { MenuItem, MenuSeparator } from '@andrewbehma/glass-ui/menu';
import { toast } from '@andrewbehma/glass-ui/toast';
import { useState } from 'react';
import { moveCard, runCard } from '../../lib/board/actions';
import {
  applyDrop,
  type DropDecision,
  type DropMove,
  decideDrop,
  moveRequest,
} from '../../lib/board/board-state';
import {
  type BoardItem,
  COLUMN_HINT,
  COLUMN_TITLE,
  canAccept,
  canGiveFeedback,
  canMarkFinished,
  canRetry,
  canRun,
  canStop,
  columnsOf,
  describeBoardError,
  isSuggestion,
  toItem,
} from '../../lib/board/format';
import { CardFace } from './card-face';
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
  runnerName,
  canOperate,
  canTerminal,
  actions,
  onOpen,
  onOpenTerminal,
  onReload,
}: {
  projectId: string;
  view: BoardView;
  runnerName?: string | null;
  canOperate: boolean;
  canTerminal: boolean;
  actions: CardActions;
  onOpen: (card: BoardCardView) => void;
  onOpenTerminal: (card: BoardCardView) => void;
  onReload: () => void;
}) {
  // The drop shown before the server answers.
  const [optimistic, setOptimistic] = useState<BoardView>();
  const [asking, setAsking] = useState<Asking>();
  const [busy, setBusy] = useState(false);
  const shown = optimistic ?? view;

  const columns: BoardColumn<BoardItem>[] = columnsOf(shown).map((c) => ({
    id: c.column,
    title: COLUMN_TITLE[c.column],
    cards: c.cards.map(toItem),
    footer:
      c.cards.length === 0 ? (
        <p className="px-1 text-xs text-ink-3">{COLUMN_HINT[c.column]}</p>
      ) : c.column === 'inbox' && canOperate ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={actions.busy || busy}
          onClick={() => actions.askDismissAll(c.cards.length)}
        >
          Dismiss all
        </Button>
      ) : undefined,
  }));

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

  const onMove = (move: DropMove) => {
    if (!canOperate) {
      toast.error('Only operators can move cards.');
      return;
    }
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
      <Board<BoardItem>
        aria-label="Project board"
        columns={columns}
        onMove={onMove}
        renderCard={(item) => <CardFace card={item.card} onOpen={onOpen} />}
        renderCardMenu={(item) => {
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
                <MenuItem tone="danger" onSelect={() => actions.askStop(card)}>
                  Stop worker
                </MenuItem>
              ) : null}
              {canOperate ? (
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
