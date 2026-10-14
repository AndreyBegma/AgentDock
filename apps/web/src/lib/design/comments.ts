import type {
  DesignCommentView,
  DesignTheme,
  MockupPinMarker,
  TaskDesignView,
} from '@agentdock/shared';

/** D10: a comment is open until a revision lists it in `addressed`. */
export const isOpen = (comment: DesignCommentView): boolean =>
  comment.addressedInRevisionId === null;

const byCreated = (a: DesignCommentView, b: DesignCommentView): number =>
  a.createdAt.localeCompare(b.createdAt);

/**
 * The right panel's groups (spec 223 "UI"): open and addressed, oldest
 * first, limited to the revision in view unless `allRevisions`.
 */
export function groupComments(
  comments: readonly DesignCommentView[],
  revisionId: string | null,
  allRevisions: boolean,
): { open: DesignCommentView[]; addressed: DesignCommentView[] } {
  const shown = comments
    .filter((c) => allRevisions || c.revisionId === revisionId)
    .sort(byCreated);
  return {
    open: shown.filter(isOpen),
    addressed: shown.filter((c) => !isOpen(c)),
  };
}

/**
 * The number a pin wears, in the panel and on its marker: its place among
 * the revision's pins by age, across every viewport and theme, so it does
 * not change when the person switches screens.
 */
export function pinNumbers(
  comments: readonly DesignCommentView[],
  revisionId: string | null,
): Map<string, number> {
  const pins = comments
    .filter((c) => c.kind === 'pin' && c.revisionId === revisionId)
    .sort(byCreated);
  return new Map(pins.map((c, i) => [c.id, i + 1]));
}

/** The markers the helper draws: the revision's pins at this viewport and theme. */
export function pinMarkers(
  comments: readonly DesignCommentView[],
  revisionId: string | null,
  viewport: string,
  theme: DesignTheme,
): MockupPinMarker[] {
  const numbers = pinNumbers(comments, revisionId);
  return comments.flatMap((c) => {
    const n = numbers.get(c.id);
    if (
      n === undefined ||
      c.viewport !== viewport ||
      c.theme !== theme ||
      c.x === null ||
      c.y === null
    ) {
      return [];
    }
    return [{ n, x: c.x, y: c.y }];
  });
}

/** Where a comment points, in words: "Pin 3 · Mobile · dark", "Desktop · light". */
export function anchorLabel(
  comment: DesignCommentView,
  pinNumber?: number,
): string | null {
  const screen = [comment.viewport, comment.theme].filter(Boolean).join(' · ');
  if (comment.kind === 'pin') {
    const pin = pinNumber === undefined ? 'Pin' : `Pin ${pinNumber}`;
    return screen ? `${pin} · ${screen}` : pin;
  }
  if (comment.kind === 'screen') return screen || null;
  return null;
}

/**
 * Why the design takes no turn, comment or approval now, or null when it
 * does. Comments and Revise share it; each adds its own condition.
 */
export function designWriteBlock(
  design: TaskDesignView,
  canOperate: boolean,
): string | null {
  if (!canOperate) return 'Viewers can read a design; an operator reviews it.';
  if (!design.needed) return 'The design is off for this task.';
  if (design.status === 'approved') return 'This design is approved.';
  if (design.activeTurnId !== null || design.status === 'generating') {
    return 'The planner is drawing the mockup.';
  }
  if (design.status === 'revising') {
    return 'The planner is revising the mockup.';
  }
  return null;
}

/** D10: Revise needs an open comment on the design. */
export function reviseBlock(
  design: TaskDesignView,
  canOperate: boolean,
): string | null {
  const block = designWriteBlock(design, canOperate);
  if (block) return block;
  if (!design.comments.some(isOpen)) {
    return 'Leave a comment first: Revise sends the open comments.';
  }
  return null;
}

/** Approve needs a revision to approve. */
export function approveBlock(
  design: TaskDesignView,
  canOperate: boolean,
): string | null {
  const block = designWriteBlock(design, canOperate);
  if (block) return block;
  if (design.revisions.length === 0) return 'Generate the design first.';
  return null;
}
