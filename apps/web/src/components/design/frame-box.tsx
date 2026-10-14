'use client';

import type { ReactNode } from 'react';

/**
 * The props of glass-ui's `ResizableFrame` (glass-ui#139), so the viewer
 * swaps this box for it with one import. Until that release the width
 * changes through the toolbar only: there is no drag handle here, because a
 * splitter is glass-ui's to draw (ADR-0011).
 */
export interface FrameBoxProps {
  /** Controlled width in px. */
  width: number;
  onWidthChange: (width: number) => void;
  onWidthCommit?: (width: number) => void;
  min: number;
  max: number;
  /** Fixed height in px; omitted fills the container. */
  height?: number;
  showSizeHint?: boolean;
  labels: { resize: string };
  children: ReactNode;
  className?: string;
}

/**
 * A controlled-width box, centred, with a hairline around its child. Wider
 * than its container, it scrolls sideways inside its own box — the page
 * never does.
 */
export function FrameBox({
  width,
  min,
  max,
  height,
  children,
  className,
}: FrameBoxProps) {
  const clamped = Math.min(max, Math.max(min, width));
  return (
    // `shrink-0`: in a scrolling column the box keeps the frame's height.
    <div className={`w-full shrink-0 overflow-x-auto ${className ?? ''}`}>
      <div
        className="mx-auto overflow-hidden rounded-md border border-line bg-content"
        style={{ width: clamped, height: height ?? '100%' }}
      >
        {children}
      </div>
    </div>
  );
}
