'use client';

import { SegmentedControlItem } from '@andrewbehma/glass-ui/segmented-control';
import type { ReactNode } from 'react';

/**
 * One option of a `SegmentedControl`: a pressed-state button, tap-sized —
 * or, in a `size="sm"` control, as tall as the shell it sits in.
 */
export function Segment({
  layoutId,
  active,
  onSelect,
  size = 'md',
  children,
}: {
  layoutId: string;
  active: boolean;
  onSelect: () => void;
  /** The control's `size`. */
  size?: 'sm' | 'md';
  children: ReactNode;
}) {
  return (
    <SegmentedControlItem
      layoutId={layoutId}
      active={active}
      className="flex-none whitespace-nowrap"
    >
      <button
        type="button"
        aria-pressed={active}
        onClick={onSelect}
        className={`relative px-3 text-sm ${size === 'sm' ? 'h-full' : 'min-h-(--size-tap)'}`}
      >
        {children}
      </button>
    </SegmentedControlItem>
  );
}
