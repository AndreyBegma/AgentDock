'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { ChevronLeft, X } from 'lucide-react';
import type { ReactNode } from 'react';

export type PhoneBackBarKind = 'back' | 'close';

/**
 * Where the bar sits: `fixed` floats it over a full-screen layer at the bottom
 * edge, above the safe area and the soft keyboard (`--keyboard-inset`);
 * `inline` leaves it in flow, for a sheet's footer slot.
 */
export type PhoneBackBarPlacement = 'fixed' | 'inline';

/** How far a layer pads its end so nothing hides under a `fixed` bar. */
export const PHONE_BACK_BAR_CLEARANCE =
  'max-lg:pb-[calc(6rem+env(safe-area-inset-bottom))]';

/** The exit button's accessible name: Back names its destination. */
export function phoneBackBarName(kind: PhoneBackBarKind, label?: string) {
  if (kind === 'close') return label ?? 'Close';
  return label ? `Back to ${label}` : 'Back';
}

/**
 * The phone way out of a full-screen layer or sheet (#675, stack S-6): a glass
 * bar in the thumb zone with a 44 px Back or Close button, an optional centred
 * title and at most one trailing action. Shown below `lg` only; from `lg` up a
 * surface keeps its desktop controls.
 *
 * Composed from glass-ui (`Button`, `glass-strong`) until glass-ui ships the
 * proposed `PhoneBackBar` primitive with this API (docs/ui/glass-ui.md,
 * "Missing in glass-ui").
 */
export function PhoneBackBar({
  kind = 'back',
  label,
  title,
  subtitle,
  action,
  onExit,
  placement = 'fixed',
}: {
  kind?: PhoneBackBarKind;
  /** The destination for Back ("Board"), or the word on Close. */
  label?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  /** At most one trailing control, 44 px tall. */
  action?: ReactNode;
  onExit: () => void;
  placement?: PhoneBackBarPlacement;
}) {
  const word = label ?? (kind === 'close' ? 'Close' : 'Back');
  const Icon = kind === 'close' ? X : ChevronLeft;
  return (
    <nav
      aria-label="Leave"
      data-phone-back-bar=""
      className={`glass-strong flex h-15 items-center gap-1.5 rounded-[22px] p-[7px] lg:hidden ${
        placement === 'fixed'
          ? 'fixed inset-x-2.5 bottom-[calc(max(env(safe-area-inset-bottom),12px)+var(--keyboard-inset))] z-[calc(var(--z-index-chrome)+2)]'
          : 'w-full'
      }`}
    >
      <Button
        type="button"
        variant="ghost"
        aria-label={phoneBackBarName(kind, label)}
        onClick={onExit}
        className="h-(--size-tap) min-w-(--size-tap) max-w-40 shrink-0 gap-1 rounded-[15px] border border-line-strong bg-raised pr-4 pl-2.5 text-[15px] text-ink active:scale-[0.97]"
      >
        <Icon aria-hidden="true" className="size-[22px] shrink-0" />
        <span className="truncate">{word}</span>
      </Button>
      <div className="min-w-0 flex-1 truncate px-1 text-center text-xs text-ink-3">
        {title ? (
          <b className="block truncate text-sm font-semibold text-ink">
            {title}
          </b>
        ) : null}
        {subtitle}
      </div>
      {action ?? <span aria-hidden="true" className="w-(--size-tap)" />}
    </nav>
  );
}
