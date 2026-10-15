import { Toggle } from '@andrewbehma/glass-ui/toggle';
import type { ReactNode } from 'react';
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
