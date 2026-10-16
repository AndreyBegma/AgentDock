import {
  type BoardCardView,
  type BoardStackDetail,
  type BoardView,
  isStackGated,
  stageName,
  type TaskDesignView,
} from '@agentdock/shared';

/**
 * The stack page (#480, built like the #431 card page): what it says about
 * the stack's stages and its design.
 */

/** "Every card of Stage 2 waits on all of Stage 1 · 6 dependencies". */
export function stageLinkText(
  stack: Pick<BoardStackDetail, 'stages'>,
  index: number,
): string {
  const before = stack.stages[index - 1];
  const stage = stack.stages[index];
  const links = (before?.cards.length ?? 0) * (stage?.cards.length ?? 0);
  return `Every card of Stage ${index + 1} waits on all of Stage ${index} · ${links} ${links === 1 ? 'dependency' : 'dependencies'}`;
}

/** "1 · Components" — the header's current stage; "Done" once every card is. */
export function currentStageText(stack: BoardStackDetail): string {
  if (stack.currentStage === null) return 'Done';
  const stage = stack.stages.find((s) => s.position === stack.currentStage);
  return `${stack.currentStage + 1} · ${stageName(stack.currentStage, stage?.title ?? '')}`;
}

/**
 * The gate banner's second sentence: which cards started before the design
 * held them — they keep running.
 */
export function gateNote(stack: BoardStackDetail): string {
  const started = stack.stages
    .flatMap((s) => s.cards)
    .filter((c) => c.round !== null && c.column !== 'completed')
    .map((c) => c.label);
  const base =
    'Nothing writes project code until the stack design is approved.';
  if (started.length === 0) return base;
  return `${base} ${started.join(', ')} ${started.length === 1 ? 'was' : 'were'} started before the design held the stack and ${started.length === 1 ? 'keeps' : 'keep'} running.`;
}

export const isGated = (stack: BoardStackDetail): boolean =>
  isStackGated(stack.design);

/**
 * The revision the page previews: the approved one, else the newest one in
 * play. Null before anything is drawn.
 */
export function previewRevision(design: TaskDesignView) {
  const approved = design.revisions.find(
    (r) => r.id === design.approvedRevisionId,
  );
  if (approved) return approved;
  const live = design.revisions.filter((r) => !r.archived);
  return live.at(-1) ?? null;
}

/**
 * The revision Approve takes from the page: the latest of the only variant
 * in play. Null when several variants compete — the viewer picks then.
 */
export function approvableRevision(design: TaskDesignView) {
  if (design.status !== 'reviewing') return null;
  const live = design.revisions.filter((r) => !r.archived);
  const variants = new Set(live.map((r) => r.variant));
  if (variants.size !== 1) return null;
  return live.reduce((a, b) => (b.revision > a.revision ? b : a));
}

/** Open comments of a design: those no revision addressed yet. */
export const openComments = (design: TaskDesignView): number =>
  design.comments.filter((c) => c.addressedInRevisionId === null).length;

/**
 * Cards Add card offers: the board's cards in no stack, not suggestions and
 * not accepted, by number.
 */
export function addableCards(view: BoardView | undefined): BoardCardView[] {
  return (view?.columns ?? [])
    .flatMap((c) => c.cards)
    .filter((c) => !c.stack && c.column !== 'inbox' && c.column !== 'completed')
    .sort((a, b) => a.number - b.number);
}

/**
 * #502: the stack page's "Stack design required" switch — on while the
 * stack's design is needed, locked while a design turn runs (Stop it first).
 */
export function designSwitch(stack: Pick<BoardStackDetail, 'design'>): {
  required: boolean;
  locked: boolean;
} {
  const status = stack.design?.status;
  return {
    required: stack.design !== null,
    locked: status === 'generating' || status === 'revising',
  };
}
