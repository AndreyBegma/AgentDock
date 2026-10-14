'use client';

import type { BoardCardView } from '@agentdock/shared';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { toast } from '@andrewbehma/glass-ui/toast';
import { type ReactNode, useCallback, useState } from 'react';
import {
  acceptCard,
  deleteCard,
  finishCard,
  runCard,
  stopCard,
} from '../../lib/board/actions';
import { describeBoardError } from '../../lib/board/format';

/** The card's own buttons, shared by the board's menu and the card sheet. */
export interface CardActions {
  run: (card: BoardCardView) => void;
  markFinished: (card: BoardCardView) => void;
  accept: (card: BoardCardView) => void;
  /** Both ask first (`ConfirmDialog`). */
  askStop: (card: BoardCardView) => void;
  askDelete: (card: BoardCardView) => void;
  busy: boolean;
  /** The confirm dialogs; render once. */
  dialogs: ReactNode;
}

type Pending = { kind: 'stop' | 'delete'; card: BoardCardView };

export function useCardActions({
  projectId,
  runnerName,
  onChanged,
  onDeleted,
}: {
  projectId: string;
  runnerName?: string | null;
  /** Refetch the board and the open sheet. */
  onChanged: () => void;
  onDeleted: (card: BoardCardView) => void;
}): CardActions {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending>();

  const perform = useCallback(
    async (job: () => Promise<unknown>, done: string) => {
      setBusy(true);
      try {
        await job();
        toast.success(done);
      } catch (err) {
        toast.error(describeBoardError(err, runnerName));
      } finally {
        setBusy(false);
        onChanged();
      }
    },
    [runnerName, onChanged],
  );

  const confirm = async () => {
    if (!pending) return;
    const { kind, card } = pending;
    if (kind === 'stop') {
      await perform(
        () => stopCard(projectId, card.number),
        `Stopped the worker of ${card.label}.`,
      );
    } else {
      await perform(async () => {
        await deleteCard(projectId, card.number);
        onDeleted(card);
      }, `Deleted ${card.label}.`);
    }
    setPending(undefined);
  };

  return {
    run: (card) =>
      void perform(
        () => runCard(projectId, card.number),
        `Started a worker on ${card.label}.`,
      ),
    markFinished: (card) =>
      void perform(
        () => finishCard(projectId, card.number),
        `${card.label} marked finished.`,
      ),
    accept: (card) =>
      void perform(
        () => acceptCard(projectId, card.number),
        `${card.label} accepted.`,
      ),
    askStop: (card) => setPending({ kind: 'stop', card }),
    askDelete: (card) => setPending({ kind: 'delete', card }),
    busy,
    dialogs: (
      <ConfirmDialog
        open={pending !== undefined}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(undefined);
        }}
        title={
          pending?.kind === 'stop'
            ? `Stop the worker of ${pending.card.label}?`
            : `Delete ${pending?.card.label ?? 'the card'}?`
        }
        consequence={
          pending?.kind === 'stop'
            ? 'The tmux session is killed. The work already committed in the worktree stays; you can run the card again.'
            : 'The card and its rounds are removed, and its worktree is cleaned up. A pull request it opened stays on GitHub.'
        }
        verb={pending?.kind === 'stop' ? 'Stop worker' : 'Delete'}
        tone="danger"
        busy={busy}
        onConfirm={() => void confirm()}
      />
    ),
  };
}
