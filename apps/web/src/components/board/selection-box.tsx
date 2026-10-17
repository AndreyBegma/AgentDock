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
 * Where a face's own boxes sit: a permanent 16 px slot at the start of the
 * header row, inside the card's `p-3` padding and border. It is always in the
 * row and only its opacity changes, so the face's layout never shifts. On a
 * coarse pointer the row grows and the slot centres in it. The card is
 * glass-ui's `li`.
 */
const BOX_SLOT = 'relative grid size-4 shrink-0 place-items-center';

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
      className={`${BOX_SLOT} opacity-0 transition-opacity [li:focus-within_&]:opacity-100 [li:hover_&]:opacity-100 ${selection.selecting ? 'opacity-100' : ''}`}
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

/**
 * Stands in the box's slot on what cannot be selected. The slot is reserved
 * always; the lock shows while `shown` (something is selected).
 */
export function UnselectableMark({
  text,
  shown,
}: {
  text: string;
  shown: boolean;
}) {
  return (
    <span className={`${BOX_SLOT} ${shown ? '' : 'invisible'}`}>
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
