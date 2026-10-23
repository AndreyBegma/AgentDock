'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { Disclosure } from '@andrewbehma/glass-ui/disclosure';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { SheetContent, SheetRoot } from '@andrewbehma/glass-ui/sheet';
import type { BoardCardDetail, CardReviewFindingView } from '@nautelle/shared';
import { useState } from 'react';
import {
  findingCounts,
  findingPlace,
  reviewFixRounds,
  reviewTracker,
  TRACKER_STATE_LABEL,
  type TrackerStep,
} from '../../lib/board/shipping';
import { useNarrow } from '../shell/narrow';

const STATE_TONE: Record<
  TrackerStep['state'],
  'ok' | 'warn' | 'danger' | 'neutral'
> = {
  pending: 'neutral',
  running: 'warn',
  passed: 'ok',
  blocked: 'danger',
  failed: 'danger',
};

/** #891: a review step's findings, from the card detail. */
const findingsOfStep = (
  findings: readonly CardReviewFindingView[],
  stepName: string,
) => findings.filter((f) => f.stepName === stepName);

function FindingList({
  findings,
}: {
  findings: readonly CardReviewFindingView[];
}) {
  return (
    <ul className="flex min-w-0 flex-col gap-3">
      {findings.map((finding, i) => {
        const place = findingPlace(finding);
        return (
          // The same finding text can repeat across steps; the index is stable.
          // biome-ignore lint/suspicious/noArrayIndexKey: findings have no id
          <li key={i} className="flex min-w-0 flex-col gap-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Badge
                tone={finding.severity === 'blocking' ? 'danger' : 'neutral'}
                size="sm"
                label={finding.severity === 'blocking' ? 'Blocking' : 'Nit'}
              />
              <span className="min-w-0 break-words font-medium">
                {finding.title}
              </span>
            </span>
            {place ? (
              <span className="break-all font-mono text-xs text-ink-3">
                {place}
              </span>
            ) : null}
            <p className="whitespace-pre-wrap break-words text-sm text-ink-2">
              {finding.body}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

/** One step of the tracker; its findings open inline, or in a sheet on a phone. */
function TrackerRow({
  step,
  findings,
  narrow,
}: {
  step: TrackerStep;
  findings: readonly CardReviewFindingView[];
  narrow: boolean;
}) {
  const [open, setOpen] = useState(false);
  const counts = findingCounts(step.blocking, step.nits);
  const head = (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="min-w-0 break-words font-medium">{step.label}</span>
      <Badge
        tone={STATE_TONE[step.state]}
        size="sm"
        label={TRACKER_STATE_LABEL[step.state]}
      />
      {counts ? (
        <span className="text-xs text-ink-3 tabular-nums">{counts}</span>
      ) : null}
    </span>
  );
  if (findings.length === 0) {
    return (
      <li data-step-state={step.state} className="min-w-0 py-1">
        {head}
      </li>
    );
  }
  if (narrow) {
    return (
      <li data-step-state={step.state} className="min-w-0">
        <SheetRoot open={open} onOpenChange={setOpen}>
          <Button
            variant="ghost"
            className="h-auto min-h-(--size-tap) w-full justify-start text-left"
            onClick={() => setOpen(true)}
          >
            {head}
          </Button>
          <SheetContent
            side="bottom"
            title={`${step.label} findings`}
            description={counts ?? undefined}
            className="h-dvh max-h-dvh"
          >
            <FindingList findings={findings} />
          </SheetContent>
        </SheetRoot>
      </li>
    );
  }
  return (
    <li data-step-state={step.state} className="min-w-0">
      <Disclosure trigger={head} open={open} onOpenChange={setOpen}>
        <FindingList findings={findings} />
      </Disclosure>
    </li>
  );
}

/**
 * #891: the card sheet's Review tab — the gate to Finished as a tracker (CI,
 * each review step, Finished), each step with its state, counts and findings,
 * and the review fix rounds with a link to their round.
 */
export function ReviewSection({
  card,
  onOpenRound,
}: {
  card: BoardCardDetail;
  onOpenRound: (round: number) => void;
}) {
  const narrow = useNarrow();
  const steps = reviewTracker(card);
  if (steps.length === 0 || card.review === null) return null;
  const findings = card.reviewFindings ?? [];
  const fixes = reviewFixRounds(card.rounds);
  return (
    <section
      aria-label="Review"
      data-layout={narrow ? 'vertical' : 'horizontal'}
      className="flex min-w-0 flex-col gap-3"
    >
      <SectionHeader title="Review" headingLevel={3} />
      <p className="text-sm text-ink-2">
        Fix rounds {Math.min(card.review.fixRound, card.review.fixLimit)} of{' '}
        {card.review.fixLimit}.
      </p>
      <ol className="flex min-w-0 flex-col gap-1">
        {steps.map((step) => (
          <TrackerRow
            key={step.key}
            step={step}
            narrow={narrow}
            findings={
              step.key === 'ci' || step.key === 'finished'
                ? []
                : findingsOfStep(findings, step.label)
            }
          />
        ))}
      </ol>
      {fixes.length > 0 ? (
        <ul aria-label="Review fix rounds" className="flex flex-col gap-1">
          {fixes.map((fix) => (
            <li key={fix.round}>
              <Button
                variant="ghost"
                className="h-auto min-h-(--size-tap) justify-start text-left"
                onClick={() => onOpenRound(fix.round)}
              >
                {fix.label}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
