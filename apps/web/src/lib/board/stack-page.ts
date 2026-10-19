import {
  type BoardCardView,
  type BoardStackDetail,
  type BoardStackView,
  type BoardView,
  cardLabel,
  isStackGated,
  type StackCardRunState,
  type StackRunView,
  stackRunText,
  stageName,
  type TaskDesignView,
} from '@agentdock/shared';
import type { Status } from '@andrewbehma/glass-ui/status-pill';
import { ApiError } from '../api';
import { describeBoardError } from './format';

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

/**
 * #652: the Run stack button — disabled for a viewer, while the stack design
 * holds the stack, and while the run is running with nothing left to queue.
 * "Resume" once the run paused or stopped with cards left in To Do.
 */
export function runStackControl(
  stack: BoardStackDetail,
  canOperate: boolean,
): { label: string; disabled: boolean; reason: string | null } {
  const todo = stack.stages
    .flatMap((s) => s.cards)
    .filter((c) => c.column === 'todo' && c.run === null).length;
  const resumes =
    stack.run?.state === 'paused' || stack.run?.state === 'stopped';
  const label = resumes ? 'Resume stack' : 'Run stack';
  if (!canOperate) {
    return { label, disabled: true, reason: 'Operators run a stack' };
  }
  if (isGated(stack)) {
    return {
      label,
      disabled: true,
      reason: 'Waits for the stack design to be approved',
    };
  }
  if (stack.run?.state === 'paused') {
    return { label, disabled: false, reason: null };
  }
  if (todo === 0) {
    return {
      label,
      disabled: true,
      reason:
        stack.run?.state === 'running'
          ? 'Every card in To Do is queued already'
          : 'No card of the stack is in To Do',
    };
  }
  return { label, disabled: false, reason: null };
}

/** #652: Stop is offered while the run has cards queued or is paused. */
export const canStopStack = (run: StackRunView | null): boolean =>
  run !== null &&
  (run.state === 'paused' ||
    (run.state === 'running' && run.queued + run.waiting > 0));

const RUN_STATUS: Record<StackRunView['state'], Status> = {
  running: 'running',
  paused: 'paused',
  stopped: 'idle',
  done: 'done',
};

/** #652: the run's pill — "Running · 2 running · 1 queued". */
export const stackRunPill = (
  run: StackRunView,
): { status: Status; label: string } => ({
  status: RUN_STATUS[run.state],
  label: stackRunText(run),
});

/** #652: a stack face's one-line run state; null without a run. */
export const stackFaceRunPill = (
  stack: Pick<BoardStackView, 'run'>,
): { status: Status; label: string } | null =>
  stack.run && stack.run.state !== 'stopped'
    ? {
        status: RUN_STATUS[stack.run.state],
        label:
          stack.run.state === 'paused'
            ? 'Run paused'
            : stack.run.state === 'done'
              ? 'Run done'
              : stack.run.running > 0
                ? `${stack.run.running} running`
                : 'Run queued',
      }
    : null;

/** #652: a card's place in the stack run, as its row shows it. */
export const CARD_RUN_PILL: Record<
  StackCardRunState,
  { status: Status; label: string }
> = {
  queued: { status: 'idle', label: 'Queued' },
  waiting: { status: 'waiting', label: 'Waiting for a dependency' },
  running: { status: 'running', label: 'Running in the stack run' },
  paused: { status: 'paused', label: 'Paused the run' },
};

/** #652: why the run paused, as a sentence: "C-12 did not start: …". */
export function pauseText(run: StackRunView): string | null {
  const pause = run.pause;
  if (!pause) return null;
  const card = pause.card !== null ? cardLabel(pause.card) : 'A card';
  const reason =
    pause.code === 'round_failed' || pause.code === 'unknown'
      ? pause.message
      : describeBoardError(
          // `ApiError.code` is typed for auth codes; a board code travels in it too.
          new ApiError(
            409,
            pause.code as ApiError['code'],
            pause.message,
            undefined,
            null,
          ),
        );
  const text = reason.replace(/\.$/, '');
  return pause.code === 'round_failed'
    ? `${text}.`
    : `${card} did not start: ${text}.`;
}

/** #652: what pressing Run stack again does after a pause. */
export const PAUSE_HINT =
  'Fix the cause, then press Resume stack: the run continues from the cards left. Stop removes the queue.';
