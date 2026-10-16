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
 * first, limited to the revision in view unless `allRevisions` — and, with a
 * `frame` (#441), to that frame of it.
 */
export function groupComments(
  comments: readonly DesignCommentView[],
  revisionId: string | null,
  allRevisions: boolean,
  frame: number | null = null,
): { open: DesignCommentView[]; addressed: DesignCommentView[] } {
  const shown = comments
    .filter((c) => allRevisions || c.revisionId === revisionId)
    .filter((c) => frame === null || c.frame === frame)
    .sort(byCreated);
  return {
    open: shown.filter(isOpen),
    addressed: shown.filter((c) => !isOpen(c)),
  };
}

/**
 * The number a pin wears, in the panel and on its marker: its place among
 * the revision's pins by age, across every viewport, theme and frame, so it
 * does not change when the person switches screens or frames.
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

/**
 * The markers the helper draws: the revision's pins at this viewport and
 * theme, on the frame in view (#441) — a pin shows only where it was made.
 */
export function pinMarkers(
  comments: readonly DesignCommentView[],
  revisionId: string | null,
  viewport: string,
  theme: DesignTheme,
  frame = 0,
): MockupPinMarker[] {
  const numbers = pinNumbers(comments, revisionId);
  return comments.flatMap((c) => {
    const n = numbers.get(c.id);
    if (
      n === undefined ||
      c.frame !== frame ||
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
 * #441: the frames of a revision that hold an open pin, by position — the
 * tab strip marks them.
 */
export function framesWithOpenPins(
  comments: readonly DesignCommentView[],
  revisionId: string | null,
): Set<number> {
  return new Set(
    comments
      .filter(
        (c) => c.kind === 'pin' && c.revisionId === revisionId && isOpen(c),
      )
      .map((c) => c.frame),
  );
}

/** #441: open comments of a revision per frame, by position. */
export function openCommentsByFrame(
  comments: readonly DesignCommentView[],
  revisionId: string | null,
): Map<number, number> {
  const counts = new Map<number, number>();
  for (const c of comments) {
    if (c.revisionId !== revisionId || !isOpen(c)) continue;
    counts.set(c.frame, (counts.get(c.frame) ?? 0) + 1);
  }
  return counts;
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
  if (
    design.activeTurnId !== null ||
    design.status === 'generating' ||
    design.status === 'revising'
  ) {
    return 'A design run is under way; wait for it or stop it.';
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
