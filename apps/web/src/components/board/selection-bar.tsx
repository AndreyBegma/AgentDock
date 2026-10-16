import type { ReactNode } from 'react';

/**
 * #452 / ADR-0011: the floating action bar is glass-ui's `SelectionBar`
 * (glass-strong, fixed at the bottom centre, role `toolbar`), which is not in
 * the glass-ui this app is on yet. Until it ships this renders nothing — no
 * bar is drawn here — and moving to it is this one line:
 *
 *   export { SelectionBar } from '@andrewbehma/glass-ui/selection-bar';
 */
export function SelectionBar(_props: {
  open: boolean;
  'aria-label': string;
  children: ReactNode;
}): null {
  return null;
}
