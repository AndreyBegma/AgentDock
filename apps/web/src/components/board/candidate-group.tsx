'use client';

import type { PlanCandidateView, PlanDetail } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { Checkbox } from '@andrewbehma/glass-ui/checkbox';
import { Chip } from '@andrewbehma/glass-ui/chip';
import { Check, Paperclip, X } from 'lucide-react';
import {
  acceptAllLabel,
  candidatesOf,
  excerptOf,
  groupMetaText,
} from '../../lib/board/candidates';
import { draftTitle } from '../../lib/board/intake';
import { pluralize } from '../../lib/format';
import { KindChip } from './split-review';

/**
 * #592 (ADR-0055): an intake under review on the Drafts strip — its
 * candidates as rows, each with a checkbox, its kind, title and two lines of
 * its body, and Open / Reject / Accept. A proposed stack numbers its stages
 * on a line; a proposed split or stack has **Accept all** (Accept rest once
 * a row is decided). Decided rows stay — the card an accepted one became,
 * where the attachments went, "no card made" for a rejected one — until
 * every row is decided and the intake leaves Drafts.
 */
export function CandidateGroup({
  plan,
  selected,
  busy,
  onToggle,
  onOpen,
  onAccept,
  onReject,
  onAcceptAll,
  onOpenCard,
}: {
  plan: PlanDetail;
  selected: ReadonlySet<string>;
  /** A decision is in flight: every button waits. */
  busy: boolean;
  onToggle: (candidate: PlanCandidateView, on: boolean) => void;
  onOpen: (candidate: PlanCandidateView) => void;
  onAccept: (candidate: PlanCandidateView) => void;
  onReject: (candidate: PlanCandidateView) => void;
  onAcceptAll: () => void;
  onOpenCard: (number: number) => void;
}) {
  const candidates = candidatesOf(plan);
  const stack = plan.intake?.candidateStack ?? null;
  const all = acceptAllLabel(plan);
  const attachments = plan.intake?.attachments ?? 0;

  return (
    <Card variant="content" pad="none" className="flex h-full min-w-0 flex-col">
      <div className="flex flex-col gap-1 border-b border-line px-3 pt-3 pb-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Chip size="sm">New work</Chip>
          <span className="truncate text-sm font-semibold text-ink">
            {draftTitle(plan)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 text-xs text-ink-3">
          <span aria-live="polite">{groupMetaText(plan)}</span>
          {all ? (
            <Button
              size="sm"
              variant="glass"
              disabled={busy}
              onClick={onAcceptAll}
            >
              {all}
            </Button>
          ) : attachments > 0 ? (
            <span className="inline-flex items-center gap-1">
              <Paperclip className="size-3" aria-hidden />
              {pluralize(attachments, 'attachment')}
            </span>
          ) : null}
        </div>
      </div>
      <ul aria-label="Candidates" className="flex flex-col p-1">
        {candidates.map((candidate, i) => (
          <CandidateRow
            key={candidate.id}
            candidate={candidate}
            stage={
              stack && candidate.stage !== null ? candidate.stage + 1 : null
            }
            joined={
              stack !== null &&
              i < candidates.length - 1 &&
              candidates[i + 1].stage !== null
            }
            first={i === 0}
            selected={selected.has(candidate.id)}
            busy={busy}
            onToggle={(on) => onToggle(candidate, on)}
            onOpen={() => onOpen(candidate)}
            onAccept={() => onAccept(candidate)}
            onReject={() => onReject(candidate)}
            onOpenCard={onOpenCard}
          />
        ))}
      </ul>
    </Card>
  );
}

function CandidateRow({
  candidate,
  stage,
  joined,
  first,
  selected,
  busy,
  onToggle,
  onOpen,
  onAccept,
  onReject,
  onOpenCard,
}: {
  candidate: PlanCandidateView;
  /** 1-based, in a proposed stack; null outside one. */
  stage: number | null;
  /** A line runs down to the next row's stage. */
  joined: boolean;
  first: boolean;
  selected: boolean;
  busy: boolean;
  onToggle: (on: boolean) => void;
  onOpen: () => void;
  onAccept: () => void;
  onReject: () => void;
  onOpenCard: (number: number) => void;
}) {
  const pending = candidate.status === 'pending';
  const card = candidate.card;
  return (
    <li
      className={`flex min-w-0 gap-2.5 rounded-control px-2 py-2.5 ${first ? '' : 'border-t border-line'} ${selected ? 'bg-accent-soft' : ''} ${pending ? '' : 'opacity-75'}`}
    >
      <span className="flex w-4 shrink-0 justify-center pt-0.5">
        {pending ? (
          <Checkbox
            aria-label={`Select ${candidate.title}`}
            checked={selected}
            disabled={busy}
            onChange={(e) => onToggle(e.target.checked)}
          />
        ) : candidate.status === 'accepted' ? (
          <Check className="size-4 text-ok" aria-label="Accepted" />
        ) : (
          <X className="size-4 text-ink-3" aria-label="Rejected" />
        )}
      </span>
      {stage !== null ? (
        <span className="relative flex w-5 shrink-0 justify-center">
          <span
            title={`Stage ${stage}`}
            className="relative z-10 inline-grid size-5 place-content-center rounded-full border border-line-strong bg-surface text-[11px] font-semibold text-ink-2 tabular-nums"
          >
            {stage}
          </span>
          {joined ? (
            <span
              aria-hidden
              className="absolute top-5 -bottom-2.5 w-px bg-line-strong"
            />
          ) : null}
        </span>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <KindChip kind={candidate.kind} />
          <span
            className={`min-w-0 flex-1 truncate text-sm font-medium text-ink ${candidate.status === 'rejected' ? 'line-through' : ''}`}
          >
            {candidate.title}
          </span>
        </div>
        {pending ? (
          <>
            <p className="line-clamp-2 text-xs text-ink-2">
              {excerptOf(candidate.body)}
            </p>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={onOpen}
              >
                Open
              </Button>
              <span className="flex-1" />
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={onReject}
              >
                Reject
              </Button>
              <Button
                size="sm"
                variant="glass"
                disabled={busy}
                onClick={onAccept}
              >
                Accept
              </Button>
            </div>
          </>
        ) : card ? (
          <span className="text-xs text-ink-3">
            Accepted →{' '}
            <button
              type="button"
              className="text-accent-ink underline"
              onClick={() => onOpenCard(card.number)}
            >
              {card.label}
            </button>
            {candidate.attachments > 0 ? ' · took the attachments' : ''}
          </span>
        ) : (
          <span className="text-xs text-ink-3">
            {candidate.status === 'accepted'
              ? 'Accepted'
              : 'Rejected · no card made'}
          </span>
        )}
      </div>
    </li>
  );
}
