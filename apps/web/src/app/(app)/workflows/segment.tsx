'use client';

import { SegmentedControlItem } from '@andrewbehma/glass-ui/segmented-control';
import type { ReactNode } from 'react';

/** One option of a `SegmentedControl`: a pressed-state button, tap-sized. */
export function Segment({
  layoutId,
  active,
  onSelect,
  children,
}: {
  layoutId: string;
  active: boolean;
  onSelect: () => void;
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
        className="relative min-h-(--size-tap) px-3 text-sm"
      >
        {children}
      </button>
    </SegmentedControlItem>
  );
}
