'use client';

import type { BoardCardView, CardPullRequestView } from '@agentdock/shared';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { useEffect, useState } from 'react';
import {
  type AcceptChoice,
  acceptChoice,
  CHECKS_PILL,
  mergeMethodText,
} from '../../lib/board/accept';
import { fetchPullRequest } from '../../lib/board/actions';
import { describeBoardError } from '../../lib/board/format';
import { safeHttpsUrl } from '../../lib/queue/format';

type PullRequest =
  | { state: 'loading' }
  | { state: 'ready'; pr: CardPullRequestView | null; error?: string };

/**
 * Accept on a Finished card (#273 D10): merges the card's pull request first
 * when it is open, or only moves the card. `version` bumps after a refused
 * merge so the head the person is shown is read again.
 */
export function AcceptDialog({
  projectId,
  card,
  busy,
  version,
  onAccept,
  onClose,
}: {
  projectId: string;
  /** The card being accepted; closed while `undefined`. */
  card: BoardCardView | undefined;
  busy: boolean;
  version: number;
  /** `headSha` merges; none only moves the card. */
  onAccept: (card: BoardCardView, headSha?: string) => void;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<PullRequest>({ state: 'loading' });
  const number = card?.number;
  const hasPr = card?.prNumber != null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: version is a refetch trigger
  useEffect(() => {
    if (number === undefined) return;
    if (!hasPr) {
      setLoaded({ state: 'ready', pr: null });
      return;
    }
    let cancelled = false;
    setLoaded({ state: 'loading' });
    fetchPullRequest(projectId, number)
      .then((pr) => {
        if (!cancelled) setLoaded({ state: 'ready', pr });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoaded({
            state: 'ready',
            pr: null,
            error: describeBoardError(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, number, hasPr, version]);

  const choice: AcceptChoice | null =
    loaded.state === 'ready' && card
      ? loaded.error && hasPr
        ? { kind: 'accept_only', reason: loaded.error }
        : acceptChoice(card.prNumber, loaded.pr)
      : null;
  const pr = loaded.state === 'ready' ? loaded.pr : null;

  return (
    <DialogRoot
      open={card !== undefined}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        title={`Accept ${card?.label ?? 'the card'}?`}
        description="Accepting moves the card to Completed and closes its worker."
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant={choice?.kind === 'merge' ? 'glass' : 'solid'}
              disabled={busy || choice === null || !card}
              onClick={() => card && onAccept(card)}
            >
              Accept without merging
            </Button>
            {choice?.kind === 'merge' && card ? (
              <Button
                variant="solid"
                disabled={busy}
                onClick={() => onAccept(card, choice.headSha)}
              >
                {busy ? 'Merging…' : 'Merge pull request'}
              </Button>
            ) : null}
          </>
        }
      >
        {choice === null || !card ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            {pr ? <PullRequestBlock pr={pr} /> : null}
            {choice.kind === 'merge' ? (
              <p className="text-ink-2">
                The pull request is merged through the runner, then the card
                moves to Completed and its issue is closed.
              </p>
            ) : null}
            {choice.kind === 'already_merged' ? (
              <Banner tone="ok" title="Already merged">
                Accepting closes the card’s issue.
              </Banner>
            ) : null}
            {choice.kind === 'accept_only' ? (
              <Banner tone="info" title="Nothing to merge here">
                {choice.reason} Accepting only moves the card; the pull request
                and the issue are left as they are.
              </Banner>
            ) : null}
          </div>
        )}
      </DialogContent>
    </DialogRoot>
  );
}

function PullRequestBlock({ pr }: { pr: CardPullRequestView }) {
  const href = safeHttpsUrl(pr.url);
  const checks = CHECKS_PILL[pr.checks];
  return (
    <div className="flex flex-col gap-2 rounded-control bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline-offset-2 hover:underline"
          >
            PR #{pr.number}
          </a>
        ) : (
          <span className="font-medium">PR #{pr.number}</span>
        )}
        {pr.state === 'open' ? (
          <StatusPill size="sm" status={checks.status} label={checks.label} />
        ) : null}
      </div>
      {pr.state === 'open' ? (
        <p className="text-xs text-ink-2">
          Method: {mergeMethodText(pr.method)}
          {pr.mergeable === 'CONFLICTING' ? ' · has conflicts' : ''}
        </p>
      ) : null}
    </div>
  );
}
