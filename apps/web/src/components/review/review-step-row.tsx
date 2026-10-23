import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import type { ReviewStepView } from '@nautelle/shared';
import { ArrowDown, ArrowUp, GripVertical, Trash2 } from 'lucide-react';
import { stepSubtitle } from '../../lib/review/format';

/** What a row needs from the list; every handler is the tab's. */
export interface ReviewStepRowProps {
  step: ReviewStepView;
  index: number;
  count: number;
  /** A viewer or an operator reads; a write is the project admin's. */
  disabled: boolean;
  /** A request is in flight: no second write starts. */
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onMove: (to: number) => void;
  onEdit: () => void;
  onRegenerate: () => void;
  onDelete: () => void;
  /** Drag and drop: the row being dragged and the row it is dropped on. */
  onDragStart: () => void;
  onDrop: () => void;
}

/**
 * One review step. Wide: grip, name and source, actions, switch in a row. On a
 * phone the same pieces stack, so no action is cut off, and every control is
 * a 44 px target on a coarse pointer through `Button`.
 */
export function ReviewStepRow({
  step,
  index,
  count,
  disabled,
  busy,
  onToggle,
  onMove,
  onEdit,
  onRegenerate,
  onDelete,
  onDragStart,
  onDrop,
}: ReviewStepRowProps) {
  const builtin = step.type === 'peer_review';
  const labelId = `review-step-${step.id}`;
  const locked = disabled || busy;
  return (
    <li
      data-review-step={step.id}
      draggable={!disabled}
      onDragStart={onDragStart}
      onDragOver={(event) => {
        if (!disabled) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      className="flex flex-col gap-3 border-hairline border-t p-4 first:border-t-0 tablet:flex-row tablet:items-center"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <GripVertical
          aria-hidden="true"
          className="size-4 shrink-0 text-ink-3 max-tablet:hidden"
        />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 font-medium text-sm">
            <span id={labelId}>{step.name}</span>
            {builtin ? <Badge size="sm" label="Built-in" /> : null}
            {!step.enabled ? <Badge size="sm" label="Off" /> : null}
          </div>
          <div className="break-words text-ink-2 text-xs">
            {stepSubtitle(step)}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {builtin ? (
          <>
            <Button variant="ghost" size="sm" onClick={onEdit}>
              {disabled ? 'View instructions' : 'Edit instructions'}
            </Button>
            {!disabled ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={onRegenerate}
              >
                Regenerate
              </Button>
            ) : null}
          </>
        ) : null}
        {!disabled ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              icon
              aria-label={`Move ${step.name} up`}
              disabled={locked || index === 0}
              onClick={() => onMove(index - 1)}
            >
              <ArrowUp aria-hidden="true" className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon
              aria-label={`Move ${step.name} down`}
              disabled={locked || index === count - 1}
              onClick={() => onMove(index + 1)}
            >
              <ArrowDown aria-hidden="true" className="size-4" />
            </Button>
            {!builtin ? (
              <Button
                variant="ghost"
                size="sm"
                icon
                aria-label={`Delete ${step.name}`}
                disabled={locked}
                onClick={onDelete}
              >
                <Trash2 aria-hidden="true" className="size-4" />
              </Button>
            ) : null}
          </>
        ) : null}
        {/* glass-ui's Toggle has no `disabled`: a locked one is inert and dimmed. */}
        <span
          aria-disabled={locked || undefined}
          inert={locked || undefined}
          className={locked ? 'ml-1 opacity-60' : 'ml-1'}
        >
          <Toggle
            labelledBy={labelId}
            checked={step.enabled}
            onChange={(value) => {
              if (!locked) onToggle(value);
            }}
          />
        </span>
      </div>
    </li>
  );
}
