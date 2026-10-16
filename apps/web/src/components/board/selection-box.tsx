import { Checkbox } from '@andrewbehma/glass-ui/checkbox';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import { Lock } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';

/** What a card face needs to take part in the selection (#452). */
export interface FaceSelection {
  selected: boolean;
  /** Anything is selected: every box shows, and a plain click toggles. */
  selecting: boolean;
  /** `range`: Shift was held. */
  onToggle: (range: boolean) => void;
}

/**
 * Where a face's own boxes sit: over the card's `p-3` padding and border, so
 * the face's layout never shifts. The card is glass-ui's `li`.
 */
const BOX_PLACE = 'absolute -start-[22px] -top-[3px] z-10 size-5';

/** A click on a face while selecting, or with ⌘/Ctrl/Shift, selects instead of opening. */
export function toggleOnClick(
  event: MouseEvent,
  selection: FaceSelection | undefined,
): void {
  if (!selection) return;
  const modified = event.metaKey || event.ctrlKey || event.shiftKey;
  if (!selection.selecting && !modified) return;
  const target = event.target as HTMLElement;
  // The card menu and the face's links keep doing their own work.
  if (target.closest('a, [aria-haspopup], [data-selection-box]')) return;
  event.preventDefault();
  event.stopPropagation();
  selection.onToggle(event.shiftKey);
}

/** The card's checkbox: on hover and focus, and on every card while anything is selected. */
export function SelectionBox({
  label,
  selection,
}: {
  label: string;
  selection: FaceSelection;
}) {
  return (
    <span
      data-selection-box=""
      className={`${BOX_PLACE} grid place-items-center rounded-md bg-surface opacity-0 transition-opacity [li:focus-within_&]:opacity-100 [li:hover_&]:opacity-100 ${selection.selecting ? 'opacity-100' : ''}`}
    >
      <Checkbox
        aria-label={`Select ${label}`}
        checked={selection.selected}
        onChange={() => undefined}
        onClick={(event) => {
          event.stopPropagation();
          selection.onToggle(event.shiftKey);
        }}
      />
    </span>
  );
}

/** Stands where the box would, while selecting, on what cannot be selected. */
export function UnselectableMark({ text }: { text: string }) {
  return (
    <span className={`${BOX_PLACE} grid place-items-center`}>
      <Tooltip content={text}>
        <span className="grid place-items-center text-ink-3">
          <Lock aria-label={text} role="img" className="size-3" />
        </span>
      </Tooltip>
    </span>
  );
}

/** The accent border and tint of a selected card, over the card's whole `li`. */
export function SelectionFrame({ children }: { children: ReactNode }) {
  return <div className="relative">{children}</div>;
}

export function SelectedTint() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute -inset-[13px] rounded-surface border border-accent bg-accent-soft"
    />
  );
}
