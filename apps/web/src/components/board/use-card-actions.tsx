'use client';

import type { AcceptSuggestionRequest, BoardCardView } from '@agentdock/shared';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { toast } from '@andrewbehma/glass-ui/toast';
import { type ReactNode, useCallback, useState } from 'react';
import { acceptedMessage } from '../../lib/board/accept';
import {
  acceptCard,
  acceptSuggestion,
  deleteCard,
  dismissAllSuggestions,
  dismissSuggestion,
  finishCard,
  runCard,
  stopCard,
} from '../../lib/board/actions';
import { describeBoardError } from '../../lib/board/format';
import { AcceptDialog } from './accept-dialog';

/** The card's own buttons, shared by the board's menu and the card sheet. */
export interface CardActions {
  run: (card: BoardCardView) => void;
  markFinished: (card: BoardCardView) => void;
  accept: (card: BoardCardView) => void;
  /** #244 D9: Accept an Inbox card, with the edits of Edit & accept. Resolves `true` when it worked. */
  acceptSuggestion: (
    card: BoardCardView,
    edits?: AcceptSuggestionRequest,
  ) => Promise<boolean>;
  /** #244 D9: deletes the card and remembers its fingerprint. */
  dismiss: (card: BoardCardView) => Promise<boolean>;
  /** #244: asks first, then dismisses every Inbox card. */
  askDismissAll: (count: number) => void;
  /** Both ask first (`ConfirmDialog`). */
  askStop: (card: BoardCardView) => void;
  askDelete: (card: BoardCardView) => void;
  busy: boolean;
  /** The confirm dialogs; render once. */
  dialogs: ReactNode;
}

type Pending =
  | { kind: 'stop' | 'delete'; card: BoardCardView }
  | { kind: 'dismiss-all'; count: number };

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
  const [accepting, setAccepting] = useState<BoardCardView>();
  const [acceptVersion, setAcceptVersion] = useState(0);

  const perform = useCallback(
    async (job: () => Promise<unknown>, done: string): Promise<boolean> => {
      setBusy(true);
      try {
        await job();
        toast.success(done);
        return true;
      } catch (err) {
        toast.error(describeBoardError(err, runnerName));
        return false;
      } finally {
        setBusy(false);
        onChanged();
      }
    },
    [runnerName, onChanged],
  );

  // #273 D10: Accept asks first; `headSha` also merges the pull request.
  const accept = async (card: BoardCardView, headSha?: string) => {
    setBusy(true);
    try {
      const done = await acceptCard(
        projectId,
        card.number,
        headSha ? { merge: { headSha } } : {},
      );
      const message = acceptedMessage(card.label, done.merge);
      if (message.warn) toast.warning(message.text);
      else toast.success(message.text);
      setAccepting(undefined);
    } catch (err) {
      toast.error(describeBoardError(err, runnerName));
      // A refused merge usually means the PR moved: show it again.
      setAcceptVersion((v) => v + 1);
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const confirm = async () => {
    if (!pending) return;
    if (pending.kind === 'dismiss-all') {
      await perform(
        () => dismissAllSuggestions(projectId),
        'Dismissed every suggestion.',
      );
      setPending(undefined);
      return;
    }
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

  const dialogTitle = (): string => {
    if (pending?.kind === 'dismiss-all') {
      return pending.count === 1
        ? 'Dismiss the suggestion?'
        : `Dismiss all ${pending.count} suggestions?`;
    }
    return pending?.kind === 'stop'
      ? `Stop the worker of ${pending.card.label}?`
      : `Delete ${pending?.card.label ?? 'the card'}?`;
  };

  const dialogConsequence = (): string => {
    if (pending?.kind === 'dismiss-all') {
      return 'The cards are deleted. AgentDock remembers their titles for 90 days so the same suggestion does not come back.';
    }
    return pending?.kind === 'stop'
      ? 'The tmux session is killed. The work already committed in the worktree stays; you can run the card again.'
      : 'The card and its rounds are removed, and its worktree is cleaned up. A pull request it opened stays on GitHub.';
  };

  const verb = (): string => {
    if (pending?.kind === 'dismiss-all') return 'Dismiss all';
    return pending?.kind === 'stop' ? 'Stop worker' : 'Delete';
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
    accept: (card) => setAccepting(card),
    acceptSuggestion: (card, edits) =>
      perform(
        () => acceptSuggestion(projectId, card.number, edits),
        `${card.label} is in To Do.`,
      ),
    dismiss: (card) =>
      perform(
        () => dismissSuggestion(projectId, card.number),
        `Dismissed ${card.label}.`,
      ),
    askDismissAll: (count) => setPending({ kind: 'dismiss-all', count }),
    askStop: (card) => setPending({ kind: 'stop', card }),
    askDelete: (card) => setPending({ kind: 'delete', card }),
    busy,
    dialogs: (
      <>
        <AcceptDialog
          projectId={projectId}
          card={accepting}
          busy={busy}
          version={acceptVersion}
          onAccept={(card, headSha) => void accept(card, headSha)}
          onClose={() => setAccepting(undefined)}
        />
        <ConfirmDialog
          open={pending !== undefined}
          onOpenChange={(open) => {
            if (!open && !busy) setPending(undefined);
          }}
          title={dialogTitle()}
          consequence={dialogConsequence()}
          verb={verb()}
          tone="danger"
          busy={busy}
          onConfirm={() => void confirm()}
        />
      </>
    ),
  };
}
