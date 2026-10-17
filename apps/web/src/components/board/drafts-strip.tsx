'use client';

import type {
  AcceptCandidatesRequest,
  AcceptCandidatesResponse,
  PlanCandidateView,
  PlanDetail,
  PlanListView,
  PlanSummary,
} from '@agentdock/shared';
// glass-ui 0.34.0 exports `SelectionBar` from the barrel only (see bulk-action-bar.tsx).
import { SelectionBar } from '@andrewbehma/glass-ui';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { Chip } from '@andrewbehma/glass-ui/chip';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { toast } from '@andrewbehma/glass-ui/toast';
import { Layers } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api';
import {
  acceptCandidates,
  rejectCandidate,
} from '../../lib/board/candidate-actions';
import {
  acceptAllRequest,
  acceptedText,
  acceptOneRequest,
  candidateDecidedOf,
  type IntakeCandidate,
  isUnderReview,
  pendingOf,
  waitingText,
} from '../../lib/board/candidates';
import {
  DRAFTS_SHOWN_MAX,
  draftStateText,
  draftTitle,
  openDrafts,
} from '../../lib/board/intake';
import { describePlannerError } from '../../lib/planner/format';
import { planApi } from '../../lib/planner/href';
import { useSection } from '../../lib/section/use-section';
import {
  AcceptCandidatesDialog,
  type AcceptMode,
} from './accept-candidates-dialog';
import { CandidateGroup } from './candidate-group';
import { CandidateSheet } from './candidate-sheet';

/**
 * Drafts (#337 D2), above the columns: the person's open New work intakes
 * and earlier plans, each with where it stands — "2 questions waiting",
 * "thinking…", "split into 3 cards?" (#409) — and **Resume** / **Discard**.
 * Discard closes the plan (archive); no card is made. Hidden when there is
 * none.
 *
 * #592 (ADR-0055): an intake that wrote its cards shows them as candidates —
 * nothing reaches Todo until the person accepts it. Each opens in a sheet to
 * read and edit; candidates selected across intakes are accepted together
 * from the selection bar, as independent cards or as one stack.
 */
export function DraftsStrip({
  projectId,
  userId,
  version,
  onResume,
  onDiscarded,
  onOpenCard,
}: {
  projectId: string;
  userId: string;
  /** Bumped by the Board's live pushes and mutations. */
  version: number;
  onResume: (plan: PlanSummary) => void;
  onDiscarded: (plan: PlanSummary) => void;
  /** Opens a board card's sheet — the card a candidate became. */
  onOpenCard: (number: number) => void;
}) {
  const drafts = useSection(async () => {
    const list = await api<PlanListView>(`/projects/${projectId}/plans`);
    const mine = openDrafts(list.items, userId).slice(0, DRAFTS_SHOWN_MAX);
    // The summary has no round or running turn: each draft's detail does.
    const details = await Promise.all(
      mine.map((p) =>
        api<PlanDetail>(planApi(projectId, p.id)).catch(() => undefined),
      ),
    );
    return mine.map((summary, i) => ({ summary, detail: details[i] }));
  }, [projectId, userId, version]);
  const [discarding, setDiscarding] = useState<PlanSummary>();
  const [busy, setBusy] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [opened, setOpened] = useState<{ planId: string; id: string }>();
  const [accepting, setAccepting] = useState<AcceptMode>();

  const items = drafts.data ?? [];
  const reviewed = items
    .map((i) => i.detail)
    .filter((d): d is PlanDetail => isUnderReview(d));
  // The selection, in the strip's order; a candidate decided meanwhile drops out.
  const selected: IntakeCandidate[] = reviewed.flatMap((plan) =>
    pendingOf(plan)
      .filter((c) => picked.has(c.id))
      .map((candidate) => ({ candidate, plan })),
  );
  const openPlan = reviewed.find((p) => p.id === opened?.planId);
  const openCandidate = openPlan?.intake?.candidates?.find(
    (c) => c.id === opened?.id,
  );

  const toggle = (candidate: PlanCandidateView, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(candidate.id);
      else next.delete(candidate.id);
      return next;
    });

  const decided = (ids: readonly string[]) => {
    setPicked((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
    drafts.retry();
  };

  const decide = async (
    ids: readonly string[],
    action: () => Promise<string>,
  ) => {
    setDeciding(true);
    try {
      toast.success(await action());
    } catch (err) {
      const was = candidateDecidedOf(err);
      toast.error(
        was
          ? `It was ${was.status} already${was.card ? ` as ${was.card.label}` : ''}.`
          : describePlannerError(err),
      );
    } finally {
      setDeciding(false);
      decided(ids);
    }
  };

  const accept = (request: AcceptCandidatesRequest) =>
    decide(
      request.candidates.map((c) => c.id),
      async () => acceptedText(await acceptCandidates(projectId, request)),
    );

  const reject = (candidate: PlanCandidateView) =>
    decide([candidate.id], async () => {
      await rejectCandidate(projectId, candidate);
      return 'Candidate rejected. No card was made.';
    });

  const discard = async () => {
    if (!discarding) return;
    setBusy(true);
    try {
      await api(`${planApi(projectId, discarding.id)}/archive`, {
        method: 'POST',
      });
      toast.success('Draft discarded.');
      onDiscarded(discarding);
      setDiscarding(undefined);
      drafts.retry();
    } catch (err) {
      toast.error(describePlannerError(err));
    } finally {
      setBusy(false);
    }
  };

  if (items.length === 0) return null;
  const waiting = waitingText(reviewed);
  const from = [...new Set(selected.map((s) => draftTitle(s.plan)))];

  return (
    <section aria-labelledby="board-drafts" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="flex flex-col">
          <h2 id="board-drafts" className="text-sm font-semibold text-ink">
            Drafts
          </h2>
          {reviewed.length > 0 ? (
            <p className="text-xs text-ink-3">
              Cards the intake wrote. Nothing reaches Todo until you accept it.
            </p>
          ) : null}
        </div>
        {waiting ? (
          <span className="text-xs text-ink-3" aria-live="polite">
            {waiting}
          </span>
        ) : null}
      </div>
      <ul className="flex min-w-0 items-start gap-3 overflow-x-auto pb-1">
        {items.map(({ summary, detail }) =>
          detail && isUnderReview(detail) ? (
            <li
              key={summary.id}
              className={`shrink-0 ${detail.intake?.candidateStack ? 'w-[400px]' : 'w-[340px]'} max-w-[calc(100vw-2rem)]`}
            >
              <CandidateGroup
                plan={detail}
                selected={picked}
                busy={deciding}
                onToggle={toggle}
                onOpen={(c) => setOpened({ planId: detail.id, id: c.id })}
                onAccept={(c) => void accept(acceptOneRequest(c))}
                onReject={(c) => void reject(c)}
                onAcceptAll={() => void accept(acceptAllRequest(detail))}
                onOpenCard={onOpenCard}
              />
            </li>
          ) : (
            <li key={summary.id} className="w-72 shrink-0">
              <Card
                variant="content"
                pad="sm"
                className="flex h-full min-w-0 flex-col gap-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Chip size="sm">
                    {summary.mode === 'card' ? 'New work' : 'Plan'}
                  </Chip>
                  <span className="truncate text-sm font-medium text-ink">
                    {draftTitle(summary)}
                  </span>
                </div>
                <span className="text-xs text-ink-2" aria-live="polite">
                  {draftStateText(detail) ?? '…'}
                </span>
                <div className="mt-auto flex gap-2">
                  <Button size="sm" onClick={() => onResume(summary)}>
                    Resume
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDiscarding(summary)}
                  >
                    Discard
                  </Button>
                </div>
              </Card>
            </li>
          ),
        )}
      </ul>
      {selected.length > 0 ? (
        <SelectionBar
          aria-label="Selected candidates"
          count={selected.length}
          onClear={() => setPicked(new Set())}
          label={(n) =>
            `${n} selected · from ${from.length === 1 ? from[0] : `${from.length} intakes`}`
          }
          actions={[
            {
              id: 'cards',
              label: 'Accept as independent cards',
              tone: 'glass',
              disabled: deciding,
              onSelect: () => setAccepting('cards'),
            },
            {
              id: 'stack',
              label: 'Accept as stack…',
              icon: Layers,
              tone: 'glass',
              disabled: deciding || selected.length < 2,
              onSelect: () => setAccepting('stack'),
            },
          ]}
        />
      ) : null}
      <CandidateSheet
        projectId={projectId}
        plan={openCandidate ? openPlan : undefined}
        candidate={openCandidate}
        canOperate
        onClose={() => setOpened(undefined)}
        onChanged={() => drafts.retry()}
        onOpenCard={(number) => {
          setOpened(undefined);
          onOpenCard(number);
        }}
      />
      <AcceptCandidatesDialog
        projectId={projectId}
        mode={accepting}
        selected={selected}
        onOpenChange={(open) => {
          if (!open) setAccepting(undefined);
        }}
        onAccepted={(made: AcceptCandidatesResponse) => {
          toast.success(acceptedText(made));
          setAccepting(undefined);
          decided(made.cards.map((c) => c.candidateId));
        }}
      />
      <ConfirmDialog
        open={discarding !== undefined}
        onOpenChange={(open) => {
          if (!open && !busy) setDiscarding(undefined);
        }}
        title={`Discard “${discarding ? draftTitle(discarding) : ''}”?`}
        consequence={
          discarding?.mode === 'card'
            ? 'The interview is closed and no card is made from it.'
            : 'The plan is closed and no cards are made from it.'
        }
        verb="Discard"
        tone="danger"
        busy={busy}
        onConfirm={() => void discard()}
      />
    </section>
  );
}
