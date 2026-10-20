'use client';

import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { toast } from '@andrewbehma/glass-ui/toast';
import {
  type BoardCardView,
  BULK_CARDS_MAX,
  type BulkBoardCardsResponse,
  type BulkCardAction,
  type BulkCardOutcome,
} from '@nautelle/shared';
import { type ReactNode, useState } from 'react';
import { bulkCards } from '../../lib/board/actions';
import { describeBoardError } from '../../lib/board/format';
import {
  BULK_SKIP_TEXT,
  type BulkPlan,
  inBatches,
  openPullRequests,
  planBulk,
  summarizeBulk,
} from '../../lib/board/selection';

/** The skipped cards a dialog lists before "and N more". */
const LISTED_SKIPS = 4;

export interface BulkActions {
  /**
   * Applies `action` to the selected cards. Move to Completed and Delete ask
   * first; the others go straight away. Does nothing when it applies to none.
   */
  run: (action: BulkCardAction, cards: readonly BoardCardView[]) => void;
  busy: boolean;
  /** The confirm dialog; render once. */
  dialogs: ReactNode;
}

interface Pending {
  action: 'complete' | 'delete';
  cards: readonly BoardCardView[];
  plan: BulkPlan;
}

const cardsText = (n: number): string => `${n} card${n === 1 ? '' : 's'}`;

function Skipped({ plan }: { plan: BulkPlan }) {
  if (plan.skipped.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="text-label text-ink-3">Skipped ({plan.skipped.length})</p>
      <ul className="mt-1.5 flex flex-col gap-1 text-xs">
        {plan.skipped.slice(0, LISTED_SKIPS).map(({ card, reason }) => (
          <li key={card.number} className="flex gap-2">
            <span className="min-w-11 font-mono text-ink">{card.label}</span>
            <span>{BULK_SKIP_TEXT[reason]}</span>
          </li>
        ))}
        {plan.skipped.length > LISTED_SKIPS ? (
          <li className="text-ink-3">
            and {plan.skipped.length - LISTED_SKIPS} more
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/** What the person is told before Move to Completed: how many PRs stay open. */
function CompleteConsequence({ plan }: { plan: BulkPlan }) {
  const open = openPullRequests(plan.applies);
  return (
    <>
      <p>
        Each card is accepted without merging or closing anything — the same as
        Accept with both options off.
      </p>
      <p className="mt-2 font-medium text-ink">
        {open === 0
          ? 'All of their pull requests are already merged or closed.'
          : `${open} of them still ${open === 1 ? 'has an' : 'have an'} open pull request. ${open === 1 ? 'Its PR stays' : 'Their PRs stay'} open on GitHub.`}
      </p>
      <Skipped plan={plan} />
    </>
  );
}

function DeleteConsequence({ plan }: { plan: BulkPlan }) {
  return (
    <>
      <p>
        The cards and their rounds are removed, and their worktrees are cleaned
        up. Issues and pull requests on GitHub are not touched.
      </p>
      {plan.skipped.length > 0 ? (
        <p className="mt-2">
          Running cards are never stopped from a bulk action.
        </p>
      ) : null}
      <Skipped plan={plan} />
    </>
  );
}

/**
 * #452: the bulk actions of the selection. A batch goes to the API in pieces
 * of `BULK_CARDS_MAX`; the answer is one toast, and `onSettled` hands the
 * outcomes back so the selection can keep the cards that were not done.
 */
export function useBulkActions({
  projectId,
  runnerName,
  onSettled,
}: {
  projectId: string;
  runnerName?: string | null;
  /** Refetch the board, and drop the cards that were done from the selection. */
  onSettled: (results: readonly BulkCardOutcome[]) => void;
}): BulkActions {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending>();

  const execute = async (
    action: BulkCardAction,
    cards: readonly BoardCardView[],
  ) => {
    setBusy(true);
    const labels = new Map(cards.map((c) => [c.number, c.label]));
    const results: BulkCardOutcome[] = [];
    try {
      for (const batch of inBatches(
        cards.map((c) => c.number),
        BULK_CARDS_MAX,
      )) {
        const answer: BulkBoardCardsResponse = await bulkCards(projectId, {
          numbers: batch,
          action,
        });
        results.push(...answer.results);
      }
    } catch (err) {
      toast.error(describeBoardError(err, runnerName));
    } finally {
      setBusy(false);
    }
    if (results.length > 0) {
      const done = summarizeBulk(
        { action, results },
        (n) => labels.get(n) ?? `C-${n}`,
      );
      if (done.warn) toast.warning(done.text);
      else toast.success(done.text);
    }
    // A batch that failed whole leaves its cards selected, like a skip.
    const reached = new Set(results.map((r) => r.number));
    onSettled([
      ...results,
      ...cards
        .filter((c) => !reached.has(c.number))
        .map(
          (c): BulkCardOutcome => ({
            number: c.number,
            status: 'error',
            code: 'unknown',
            message: 'not reached',
          }),
        ),
    ]);
  };

  const run = (action: BulkCardAction, cards: readonly BoardCardView[]) => {
    const plan = planBulk(action, cards);
    if (plan.applies.length === 0 || busy) return;
    if (action === 'complete' || action === 'delete') {
      setPending({ action, cards, plan });
      return;
    }
    void execute(action, cards);
  };

  const confirm = async () => {
    if (!pending) return;
    const { action, cards } = pending;
    await execute(action, cards);
    setPending(undefined);
  };

  const n = pending?.plan.applies.length ?? 0;
  return {
    run,
    busy,
    dialogs: (
      <ConfirmDialog
        open={pending !== undefined}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(undefined);
        }}
        title={
          pending?.action === 'delete'
            ? `Delete ${cardsText(n)}?`
            : `Move ${cardsText(n)} to Completed?`
        }
        consequence={
          pending ? (
            pending.action === 'delete' ? (
              <DeleteConsequence plan={pending.plan} />
            ) : (
              <CompleteConsequence plan={pending.plan} />
            )
          ) : undefined
        }
        verb={
          pending?.action === 'delete'
            ? `Delete ${cardsText(n)}`
            : `Move ${cardsText(n)}`
        }
        tone={pending?.action === 'delete' ? 'danger' : 'default'}
        busy={busy}
        onConfirm={() => void confirm()}
      />
    ),
  };
}
