'use client';

import type {
  AcceptBoardCardRequest,
  BoardCardView,
  CardPullRequestView,
} from '@agentdock/shared';
import type { RunnerCommands } from '@agentdock/shared/protocol';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Checkbox } from '@andrewbehma/glass-ui/checkbox';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { Radio, RadioGroup } from '@andrewbehma/glass-ui/radio-group';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { useEffect, useState } from 'react';
import {
  type AcceptChoice,
  type AcceptOptions,
  acceptChoice,
  BRANCH_CLEANUP_HINT,
  type BranchCleanupGate,
  branchCleanupGate,
  CHECKS_PILL,
  defaultAcceptOptions,
  deleteBranchControl,
  isTerminalCard,
  mergeMethodText,
  mergeRequest,
  noMergeRequest,
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
  runnerCommands,
  onAccept,
  unlanded = null,
  onConfirmUnlanded,
  onClose,
}: {
  projectId: string;
  /** The card being accepted; closed while `undefined`. */
  card: BoardCardView | undefined;
  busy: boolean;
  version: number;
  /** What the runner advertised; gates the branch cleanup (#329 D9). */
  runnerCommands?: RunnerCommands | null;
  /** `merge` merges, `closePr` closes the PR, `{}` only moves the card. */
  onAccept: (card: BoardCardView, request: AcceptBoardCardRequest) => void;
  /**
   * #709: why the last Accept was refused — the card's work is not in the
   * base; the dialog then asks the person to confirm instead.
   */
  unlanded?: string | null;
  /** #709: Accept again, confirmed. */
  onConfirmUnlanded?: (card: BoardCardView) => void;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<PullRequest>({ state: 'loading' });
  const [options, setOptions] = useState<AcceptOptions>(
    defaultAcceptOptions({ source: 'manual' }),
  );
  const number = card?.number;
  const source = card?.source;

  // Each card opens with its own defaults (a terminal card keeps its branch).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per card
  useEffect(() => {
    setOptions(defaultAcceptOptions({ source: source ?? 'manual' }));
  }, [number, source]);
  const fleet = card?.source === 'fleet';
  const hasPr = card?.prNumber != null && !fleet;

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
        : acceptChoice(card.prNumber, loaded.pr, { fleet })
      : null;
  const pr = loaded.state === 'ready' ? loaded.pr : null;

  // #329 D7/D8/D9: the branch and close choices, gated by the runner's advert.
  const gate = branchCleanupGate(runnerCommands);
  const canClose = !!card && !fleet && pr?.state === 'open';
  const closing = canClose && gate === 'ok' && options.closePr;
  const deleteControl = card
    ? deleteBranchControl(card, options, gate)
    : { checked: false, disabled: true, hint: null };
  const acceptWithoutMerge = (c: BoardCardView) =>
    onAccept(c, noMergeRequest(c, options, gate));

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
          unlanded !== null && card ? (
            <>
              <Button variant="ghost" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="solid"
                disabled={busy}
                onClick={() => onConfirmUnlanded?.(card)}
              >
                {busy ? 'Accepting…' : 'Accept anyway'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant={choice?.kind === 'merge' ? 'glass' : 'solid'}
                disabled={busy || choice === null || !card}
                onClick={() => {
                  if (!card) return;
                  // Already merged: the merge request is what closes the issue (D13).
                  if (choice?.kind === 'already_merged') {
                    onAccept(card, { merge: { headSha: choice.headSha } });
                  } else {
                    acceptWithoutMerge(card);
                  }
                }}
              >
                {choice?.kind === 'already_merged'
                  ? 'Accept'
                  : closing
                    ? busy
                      ? 'Closing…'
                      : 'Close pull request and accept'
                    : 'Accept without merging'}
              </Button>
              {choice?.kind === 'merge' && card ? (
                <Button
                  variant="solid"
                  disabled={busy}
                  onClick={() =>
                    onAccept(
                      card,
                      mergeRequest(card, choice.headSha, options, gate),
                    )
                  }
                >
                  {busy ? 'Merging…' : 'Merge pull request'}
                </Button>
              ) : null}
            </>
          )
        }
      >
        {unlanded !== null && card ? (
          <UnlandedBanner reason={unlanded} />
        ) : choice === null || !card ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            {pr ? <PullRequestBlock pr={pr} /> : null}
            {choice.kind === 'merge' ? (
              <>
                <p className="text-ink-2">
                  The pull request is merged through the runner, then the card
                  moves to Completed and its issue is closed.
                </p>
                <Checkbox
                  label="Delete the branch on GitHub"
                  hint={deleteControl.hint ?? undefined}
                  checked={deleteControl.checked}
                  disabled={busy || deleteControl.disabled}
                  onChange={(e) =>
                    setOptions({ ...options, deleteBranch: e.target.checked })
                  }
                />
              </>
            ) : null}
            {canClose ? (
              <ClosePrChoice
                card={card}
                options={options}
                gate={gate}
                busy={busy}
                onChange={setOptions}
              />
            ) : null}
            {choice.kind === 'already_merged' ? (
              <Banner tone="ok" title="Already merged">
                Accepting closes the card’s issue.
              </Banner>
            ) : null}
            {choice.kind === 'accept_only' ? (
              <Banner tone="info" title="Nothing to merge here">
                {choice.reason}{' '}
                {closing
                  ? 'Accepting closes the pull request, then moves the card.'
                  : 'Accepting only moves the card; the pull request and the issue are left as they are.'}
              </Banner>
            ) : null}
          </div>
        )}
      </DialogContent>
    </DialogRoot>
  );
}

/**
 * #709: Completed means landed — Accept named the landing the card's work
 * still lacks, and the person confirms before it moves.
 */
export function UnlandedBanner({ reason }: { reason: string }) {
  return (
    <Banner tone="warn" title="Its work is not in the base">
      {reason}. Accept anyway only if this work is not meant to land; otherwise
      merge its pull request into the base first.
    </Banner>
  );
}

/**
 * #329 D8: under Accept without merging — leave the PR open (the default), or
 * close it and delete its branch. Hidden with the update hint on a runner
 * that does not serve `card.prClose` (D9).
 */
function ClosePrChoice({
  card,
  options,
  gate,
  busy,
  onChange,
}: {
  card: BoardCardView;
  options: AcceptOptions;
  gate: BranchCleanupGate;
  busy: boolean;
  onChange: (options: AcceptOptions) => void;
}) {
  if (gate !== 'ok') {
    return <p className="text-xs text-ink-2">{BRANCH_CLEANUP_HINT[gate]}</p>;
  }
  const keepsBranch = isTerminalCard(card);
  return (
    <div className="flex flex-col gap-2">
      <RadioGroup label="If you accept without merging">
        <Radio
          name="accept-pr"
          label="Leave the PR open"
          checked={!options.closePr}
          disabled={busy}
          onChange={() => onChange({ ...options, closePr: false })}
        />
        <Radio
          name="accept-pr"
          label={
            keepsBranch ? 'Close the PR' : 'Close the PR and delete its branch'
          }
          hint={
            keepsBranch
              ? 'A terminal card’s branch is your session branch, so it is kept.'
              : undefined
          }
          checked={options.closePr}
          disabled={busy}
          onChange={() => onChange({ ...options, closePr: true })}
        />
      </RadioGroup>
      {options.closePr && card.issueNumber !== null ? (
        <Checkbox
          label="Close the issue as not planned"
          checked={options.closeIssue}
          disabled={busy}
          onChange={(e) =>
            onChange({ ...options, closeIssue: e.target.checked })
          }
        />
      ) : null}
    </div>
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
