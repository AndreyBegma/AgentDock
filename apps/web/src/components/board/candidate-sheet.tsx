'use client';

import {
  CARD_DRAFT_BODY_MAX,
  CARD_DRAFT_TITLE_MAX,
  type CandidateDecidedDetails,
  type PlanCandidateView,
  type PlanDetail,
  type PlanTaskKind,
} from '@agentdock/shared';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Chip } from '@andrewbehma/glass-ui/chip';
import { Field, Input, Textarea } from '@andrewbehma/glass-ui/field';
import { KeyValueList } from '@andrewbehma/glass-ui/key-value-list';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@andrewbehma/glass-ui/segmented-control';
import { SheetContent, SheetRoot } from '@andrewbehma/glass-ui/sheet';
import { toast } from '@andrewbehma/glass-ui/toast';
import { useState } from 'react';
import {
  acceptCandidates,
  rejectCandidate,
  updateCandidate,
} from '../../lib/board/candidate-actions';
import {
  acceptedText,
  acceptOneRequest,
  attachmentsText,
  candidateContext,
  candidateDecidedOf,
  candidateTitleProblem,
  dependsOnText,
  isCandidateStale,
} from '../../lib/board/candidates';
import { draftTitle } from '../../lib/board/intake';
import { describePlannerError } from '../../lib/planner/format';

const KINDS: { kind: PlanTaskKind; label: string }[] = [
  { kind: 'feature', label: 'Feature' },
  { kind: 'bug', label: 'Bug' },
];

/**
 * #592 (ADR-0057): a candidate, opened from Drafts — its title, kind and
 * full Markdown body, edited by hand and saved before deciding; **Reject**,
 * or **Accept to Todo**, which saves the edits first. A title with a letter
 * outside ASCII is refused inline, as split titles are. A candidate decided
 * elsewhere — another tab, a teammate — turns read-only and points to its
 * card.
 */
export function CandidateSheet({
  projectId,
  plan,
  candidate,
  canOperate,
  onClose,
  onChanged,
  onOpenCard,
}: {
  projectId: string;
  /** The intake the candidate came from; undefined closes the sheet. */
  plan: PlanDetail | undefined;
  candidate: PlanCandidateView | undefined;
  canOperate: boolean;
  onClose: () => void;
  /** After a save or a decision: the strip reads its intakes again. */
  onChanged: () => void;
  onOpenCard: (number: number) => void;
}) {
  return (
    <SheetRoot
      open={plan !== undefined && candidate !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {plan && candidate ? (
        <CandidateSheetBody
          key={candidate.id}
          projectId={projectId}
          plan={plan}
          candidate={candidate}
          canOperate={canOperate}
          onClose={onClose}
          onChanged={onChanged}
          onOpenCard={onOpenCard}
        />
      ) : null}
    </SheetRoot>
  );
}

function CandidateSheetBody({
  projectId,
  plan,
  candidate,
  canOperate,
  onClose,
  onChanged,
  onOpenCard,
}: {
  projectId: string;
  plan: PlanDetail;
  candidate: PlanCandidateView;
  canOperate: boolean;
  onClose: () => void;
  onChanged: () => void;
  onOpenCard: (number: number) => void;
}) {
  const [title, setTitle] = useState(candidate.title);
  const [kind, setKind] = useState<PlanTaskKind>(candidate.kind);
  const [body, setBody] = useState(candidate.body);
  /** The version the fields were loaded from: an edit names it. */
  const [version, setVersion] = useState(candidate.version);
  /** The text as last loaded or saved: what "Unsaved" compares against. */
  const [base, setBase] = useState({
    title: candidate.title,
    kind: candidate.kind,
    body: candidate.body,
  });
  const [busy, setBusy] = useState<'save' | 'accept' | 'reject'>();
  const [stale, setStale] = useState(false);
  const [decidedHere, setDecidedHere] = useState<CandidateDecidedDetails>();
  const [error, setError] = useState<string>();

  // Decided elsewhere: the live push brought the decision before this tab acted.
  const decided: CandidateDecidedDetails | null =
    decidedHere ??
    (candidate.status !== 'pending'
      ? {
          candidateId: candidate.id,
          status: candidate.status,
          card: candidate.card,
        }
      : null);
  const changed =
    title.trim() !== base.title || kind !== base.kind || body !== base.body;
  const problem = candidateTitleProblem(title);
  const locked = decided !== null || !canOperate;
  const context = candidateContext(plan, candidate);

  const loadLatest = () => {
    setTitle(candidate.title);
    setKind(candidate.kind);
    setBody(candidate.body);
    setVersion(candidate.version);
    setBase({
      title: candidate.title,
      kind: candidate.kind,
      body: candidate.body,
    });
    setStale(false);
  };

  const refused = (err: unknown) => {
    const was = candidateDecidedOf(err);
    if (was) setDecidedHere(was);
    else if (isCandidateStale(err)) setStale(true);
    else setError(describePlannerError(err));
    onChanged();
  };

  /** Saves the fields when they changed; the version the next call names. */
  const save = async (): Promise<number> => {
    if (!changed) return version;
    const saved = await updateCandidate(projectId, candidate, {
      version,
      title: title.trim(),
      kind,
      body,
    });
    setVersion(saved.version);
    setTitle(saved.title);
    setBase({ title: saved.title, kind: saved.kind, body: saved.body });
    return saved.version;
  };

  const run = async (
    what: 'save' | 'accept' | 'reject',
    action: () => Promise<void>,
  ) => {
    setBusy(what);
    setError(undefined);
    try {
      await action();
    } catch (err) {
      refused(err);
    } finally {
      setBusy(undefined);
    }
  };

  const onSave = () =>
    run('save', async () => {
      await save();
      toast.success('Candidate saved.');
      onChanged();
    });

  const onAccept = () =>
    run('accept', async () => {
      const current = await save();
      const made = await acceptCandidates(
        projectId,
        acceptOneRequest({ ...candidate, version: current }),
      );
      toast.success(acceptedText(made));
      onChanged();
      onClose();
    });

  const onReject = () =>
    run('reject', async () => {
      await rejectCandidate(projectId, candidate);
      toast.success('Candidate rejected. No card was made.');
      onChanged();
      onClose();
    });

  const details = [
    {
      key: 'origin',
      label: 'Origin',
      value: `Intake plan · ${draftTitle(plan)}`,
    },
    ...(dependsOnText(plan, candidate)
      ? [
          {
            key: 'depends',
            label: 'Depends on',
            value: dependsOnText(plan, candidate) as string,
          },
        ]
      : []),
    ...(attachmentsText(plan, candidate)
      ? [
          {
            key: 'attachments',
            label: 'Attachments',
            value: attachmentsText(plan, candidate) as string,
          },
        ]
      : []),
  ];

  const footer = decided ? (
    <div className="flex w-full justify-end gap-2">
      <Button variant="ghost" onClick={onClose}>
        Close
      </Button>
      {decided.card ? (
        <Button
          variant="solid"
          onClick={() =>
            onOpenCard((decided.card as { number: number }).number)
          }
        >
          Open {decided.card.label}
        </Button>
      ) : null}
    </div>
  ) : (
    <div className="flex w-full flex-wrap items-center gap-2">
      <Button
        variant="danger"
        disabled={locked || busy !== undefined}
        onClick={() => void onReject()}
      >
        {busy === 'reject' ? 'Rejecting…' : 'Reject'}
      </Button>
      <span className="flex-1" />
      {changed ? <Chip size="sm">Unsaved</Chip> : null}
      <Button
        variant="glass"
        disabled={locked || busy !== undefined || !changed || problem !== null}
        onClick={() => void onSave()}
      >
        {busy === 'save' ? 'Saving…' : 'Save'}
      </Button>
      <Button
        variant="solid"
        disabled={locked || busy !== undefined || problem !== null || stale}
        onClick={() => void onAccept()}
      >
        {busy === 'accept' ? 'Accepting…' : 'Accept to Todo'}
      </Button>
    </div>
  );

  return (
    <SheetContent
      side="right"
      title={candidate.title}
      description={`Candidate · ${context}`}
      footer={footer}
    >
      <div className="flex min-w-0 flex-col gap-4">
        {decided ? (
          <Banner
            tone="warn"
            title={`This candidate was ${decided.status} ${decidedHere ? 'in another tab' : 'already'}`}
          >
            {decided.card
              ? `It is card ${decided.card.label} in Todo now. Your edits here were not saved. Edit the card instead.`
              : 'No card was made from it. Your edits here were not saved.'}
          </Banner>
        ) : null}
        {stale && !decided ? (
          <Banner
            tone="warn"
            title="This candidate was changed in another tab"
            action={
              <Button size="sm" variant="glass" onClick={loadLatest}>
                Load the latest
              </Button>
            }
          >
            Your edits were not saved. Load the latest text, then edit again.
          </Banner>
        ) : null}
        <Field
          label="Title"
          htmlFor="candidate-title"
          hint="English, ASCII letters only, as card titles are."
          error={locked ? undefined : (problem ?? undefined)}
        >
          <Input
            id="candidate-title"
            tone="on-glass"
            value={title}
            maxLength={CARD_DRAFT_TITLE_MAX}
            disabled={locked || busy !== undefined}
            aria-invalid={!locked && problem !== null ? true : undefined}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span id="candidate-kind" className="text-sm font-medium text-ink">
            Kind
          </span>
          <SegmentedControl
            role="group"
            aria-label="Kind"
            variant="on-glass"
            className="self-start"
          >
            {KINDS.map((k) => (
              <SegmentedControlItem
                key={k.kind}
                active={kind === k.kind}
                layoutId="candidate-kind"
              >
                <button
                  type="button"
                  aria-pressed={kind === k.kind}
                  disabled={locked || busy !== undefined}
                  className="px-3 py-1 text-xs whitespace-nowrap"
                  onClick={() => setKind(k.kind)}
                >
                  {k.label}
                </button>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </div>
        <Field
          label="Body"
          htmlFor="candidate-body"
          hint="Markdown. This becomes the issue body."
        >
          <Textarea
            id="candidate-body"
            tone="on-glass"
            rows={14}
            className="font-mono text-xs"
            value={body}
            maxLength={CARD_DRAFT_BODY_MAX}
            disabled={locked || busy !== undefined}
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>
        <KeyValueList dense items={details} />
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </SheetContent>
  );
}
