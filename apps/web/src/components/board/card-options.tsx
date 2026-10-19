'use client';

import type { BoardCardView } from '@agentdock/shared';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { toast } from '@andrewbehma/glass-ui/toast';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import { type ReactNode, useState } from 'react';
import { updateCard } from '../../lib/board/actions';
import { autoRunNote } from '../../lib/board/dependencies';
import { describeBoardError } from '../../lib/board/format';
import { ReadinessSlot } from '../readiness/readiness-notice';

/**
 * glass-ui's `Toggle` has no `disabled`: a locked one is inert (no pointer, no
 * tab stop) and dimmed, and its change handler is dropped.
 */
function OptionToggle({
  id,
  checked,
  disabled,
  label,
  hint,
  notice,
  onChange,
}: {
  id: string;
  checked: boolean;
  disabled?: boolean;
  label: string;
  hint: string;
  /** Why the option cannot take effect now (rule R1). */
  notice?: ReactNode;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-sm">
        <span
          aria-disabled={disabled || undefined}
          inert={disabled || undefined}
          className={disabled ? 'opacity-60' : undefined}
        >
          <Toggle
            labelledBy={id}
            checked={checked}
            onChange={(value) => {
              if (!disabled) onChange(value);
            }}
          />
        </span>
        <span id={id}>{label}</span>
      </div>
      <span className="text-xs text-ink-3">{hint}</span>
      {notice}
    </div>
  );
}

/** #282 D3: Automatic work — a switch with its label and what off means. */
export function AutoCollectToggle({
  id,
  checked,
  disabled,
  label,
  hint,
  onChange,
}: {
  id: string;
  checked: boolean;
  disabled?: boolean;
  label: string;
  hint: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <OptionToggle
      id={id}
      checked={checked}
      disabled={disabled}
      label={label}
      hint={hint}
      onChange={onChange}
    />
  );
}

/** D2: the two things starting work can also do. Both default to off. */
export function CardOptionToggles({
  projectId,
  idPrefix,
  issueOnRun,
  specOnRun,
  disabled,
  onIssueOnRun,
  onSpecOnRun,
}: {
  projectId: string;
  idPrefix: string;
  issueOnRun: boolean;
  specOnRun: boolean;
  disabled?: boolean;
  onIssueOnRun: (value: boolean) => void;
  onSpecOnRun: (value: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <OptionToggle
        id={`${idPrefix}-issue`}
        checked={issueOnRun}
        disabled={disabled}
        label="Create a GitHub issue on Run"
        hint="The issue is never queued for the orchestrator."
        onChange={onIssueOnRun}
      />
      <OptionToggle
        id={`${idPrefix}-spec`}
        checked={specOnRun}
        disabled={disabled}
        label="Write a spec on Run"
        hint="Committed first on the card’s branch, so it lands in the pull request. Needs a spec directory in the project’s docs source."
        notice={
          specOnRun ? (
            <ReadinessSlot projectId={projectId} action="spec_on_run" />
          ) : null
        }
        onChange={onSpecOnRun}
      />
    </div>
  );
}

/**
 * #443: Auto-run when ready, under the card's dependencies — the one new
 * control; Run stays the solid action. It saves on its own, like Continue
 * after design, and the note under it says what will start the card.
 */
export function AutoRunSection({
  projectId,
  card,
  canOperate,
  onChanged,
}: {
  projectId: string;
  card: Pick<
    BoardCardView,
    'number' | 'label' | 'autoRunWhenReady' | 'readiness'
  >;
  canOperate: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [on, setOn] = useState(card.autoRunWhenReady);
  const [shown, setShown] = useState(card.autoRunWhenReady);
  // A live push or another tab's change wins over the local state.
  if (shown !== card.autoRunWhenReady) {
    setShown(card.autoRunWhenReady);
    setOn(card.autoRunWhenReady);
  }

  const change = async (next: boolean) => {
    setBusy(true);
    setOn(next);
    try {
      await updateCard(projectId, card.number, { autoRunWhenReady: next });
      onChanged();
    } catch (err) {
      setOn(!next);
      toast.error(describeBoardError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Run options" className="flex flex-col gap-3">
      <SectionHeader title="Run options" headingLevel={3} />
      <OptionToggle
        id={`card-${card.number}-auto-run`}
        checked={on}
        disabled={!canOperate || busy}
        label="Auto-run when ready"
        hint="Starts the Run when the last open dependency has a ready pull request (Finished) or is accepted. It follows the same slot and budget rules as pressing Run."
        onChange={(next) => void change(next)}
      />
      <Banner tone="info">{autoRunNote(on, card.readiness)}</Banner>
    </section>
  );
}
