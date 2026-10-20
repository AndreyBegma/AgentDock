import type { CardTriageView } from '@nautelle/shared';

/** How many hints a triage shows: duplicates count once. */
export const triageHintCount = (view: CardTriageView): number =>
  view.state === 'ready'
    ? (view.duplicates ? 1 : 0) + (view.kind ? 1 : 0) + (view.priority ? 1 : 0)
    : 0;

/**
 * #660: a priority is the card's place in its column — To Do is the queue —
 * so the hint says where Apply moves it.
 */
export const priorityHintLabel = (value: 'high' | 'low'): string =>
  value === 'high'
    ? 'Suggested priority: High — move to the top of its column'
    : 'Suggested priority: Low — move to the bottom of its column';

/** The face's chip: `1 hint`, `3 hints`. */
export const hintsLabel = (count: number): string =>
  `${count} hint${count === 1 ? '' : 's'}`;
