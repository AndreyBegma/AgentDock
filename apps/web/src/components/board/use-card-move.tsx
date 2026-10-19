'use client';

import type { BoardCardView } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { toast } from '@andrewbehma/glass-ui/toast';
import { type ReactNode, useState } from 'react';
import { moveCard } from '../../lib/board/actions';
import {
  type DropDecision,
  type DropMove,
  decideCardMove,
  MOVE_TO_END,
  moveRequest,
} from '../../lib/board/board-state';
import { runWaitsFor } from '../../lib/board/dependencies';
import { describeBoardError } from '../../lib/board/format';
import type { CardActions } from './use-card-actions';

type Asking = Extract<DropDecision, { kind: 'confirm-stop' | 'offer-run' }>;

export interface CardMove {
  busy: boolean;
  /** Acts on a decision: declines, asks, or sends the move. */
  decide: (decision: DropDecision) => void;
  /** The Move picker's choice: append the card to `column`, asking first where the rule says so. */
  moveTo: (card: BoardCardView, column: string) => void;
  /** The Run / stop dialogs; render once. */
  dialogs: ReactNode;
}

/**
 * One move, whoever asks for it: a drop, the card menu, or the Move picker.
 * Declines what the rule refuses, asks before leaving or entering In
 * progress, sends the rest, and reloads for the server's truth.
 */
export function useCardMove({
  projectId,
  runnerName,
  canOperate,
  actions,
  onStart,
  onSettled,
}: {
  projectId: string;
  runnerName?: string | null;
  canOperate: boolean;
  actions: CardActions;
  /** The move is on its way: show it before the server answers. */
  onStart?: (move: DropMove) => void;
  /** The answer is in (or refused): drop what `onStart` showed and reload. */
  onSettled: () => void;
}): CardMove {
  const [asking, setAsking] = useState<Asking>();
  const [busy, setBusy] = useState(false);

  /** Resolves `true` when the move landed. */
  const send = async (
    move: DropMove,
    number: number,
    options: { stopWorker?: boolean } = {},
  ): Promise<boolean> => {
    onStart?.(move);
    setBusy(true);
    try {
      await moveCard(
        projectId,
        number,
        moveRequest(move, options.stopWorker === true),
      );
      return true;
    } catch (err) {
      toast.error(describeBoardError(err, runnerName));
      return false;
    } finally {
      setBusy(false);
      onSettled();
    }
  };

  const decide = (decision: DropDecision) => {
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
        void send(decision.move, decision.card.number);
    }
  };

  const moveTo = (card: BoardCardView, column: string) => {
    if (!canOperate) {
      toast.error('Only operators can move cards.');
      return;
    }
    decide(
      decideCardMove(card, {
        id: card.id,
        fromColumnId: card.column,
        toColumnId: column,
        index: MOVE_TO_END,
      }),
    );
  };

  const answerRun = (run: boolean) => {
    if (asking?.kind !== 'offer-run') return;
    const { move, card } = asking;
    setAsking(undefined);
    // Run goes through the card actions, which hold it for an open dependency (#638).
    void send(move, card.number).then((moved) => {
      if (moved && run) void actions.run(card);
    });
  };

  const confirmStop = () => {
    if (asking?.kind !== 'confirm-stop') return;
    const { move, card } = asking;
    setAsking(undefined);
    void send(move, card.number, { stopWorker: true });
  };

  // #638: an open dependency holds the dialog's Run too; the move is free.
  const waits =
    asking?.kind === 'offer-run' ? runWaitsFor(asking.card.dependsOn) : null;

  const dialogs = (
    <>
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
              <Button
                disabled={waits !== null}
                aria-describedby={waits ? 'board-move-run-waits' : undefined}
                onClick={() => answerRun(true)}
              >
                Run
              </Button>
            </>
          }
        >
          <p className="text-sm text-ink-2">
            Run starts a dedicated Claude Code worker in its own worktree. “Just
            move” only changes the column.
          </p>
          {waits ? (
            <p id="board-move-run-waits" className="text-sm text-ink-3">
              {waits}: Run opens once they have a ready pull request.
            </p>
          ) : null}
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

  return { busy, decide, moveTo, dialogs };
}
