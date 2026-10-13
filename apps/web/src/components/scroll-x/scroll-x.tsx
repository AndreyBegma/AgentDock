'use client';

import { ScrollHintRow } from '@andrewbehma/glass-ui/scroll-hint-row';
import type { ReactNode } from 'react';

type ScrollXProps = {
  children: ReactNode;
  /**
   * Tailwind `from-*` colour of the fade, matching the surface behind the
   * content: `from-ground` on the page (default), `from-surface` in a card.
   */
  edgeClassName?: string;
  className?: string;
  /** Names the region for assistive technology when it scrolls (a table's caption). */
  label?: string;
};

/**
 * A wide table (or anything wider than the screen) scrolls inside its own box
 * instead of pushing the page sideways at 390 px (issue #159, R4). The fade on
 * an edge shows only while there is more content on that side.
 */
export function ScrollX({
  children,
  edgeClassName = 'from-ground',
  className = '',
  label,
}: ScrollXProps) {
  return (
    <ScrollHintRow
      edgeClassName={edgeClassName}
      className={`max-w-full overflow-x-auto overscroll-x-contain ${className}`}
      {...(label ? { role: 'region', 'aria-label': label, tabIndex: 0 } : {})}
    >
      {children}
    </ScrollHintRow>
  );
}
