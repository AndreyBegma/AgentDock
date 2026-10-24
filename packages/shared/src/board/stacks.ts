import type { TaskDesignSummary } from '../design/contracts';
import type {
  BoardCardView,
  BoardErrorCode,
  CardPrTarget,
  CardRoundBrief,
} from './contracts';
import { BOARD_COLUMNS, type BoardColumn } from './types';

/**
 * Stacks (#480, ADR-0044): a group of cards that make one larger piece of
 * work, ordered in stages, under one optional shared design. Every card of
 * stage N+1 depends on every card of stage N through ordinary card
 * dependencies; while the stack's design is needed and not approved, no card
 * of the stack runs.
 */

/** The per-project number as people see it. */
export const stackLabel = (number: number): string => `S-${number}`;

/** The reason Run is refused on a card of a stack whose design is pending. */
export const STACK_GATE_REASON = 'Waits for the stack design to be approved';

/** "Stage 1" — a stage's name when it has no title. */
export const stageName = (position: number, title: string): string =>
  title.trim() ? title.trim() : `Stage ${position + 1}`;

/** A card's stack, as its face and its sheet show it. */
export interface CardStackRef {
  number: number;
  /** `S-<number>`. */
  label: string;
  title: string;
  /** 0-based. */
  stage: number;
  stageTitle: string;
  /**
   * `STACK_GATE_REASON` while the stack's design is needed and not approved:
   * Run is refused. Null when the card may run as far as its stack goes.
   */
  gate: string | null;
}

/** One stage of a stack on the board: its cards by number, in position order. */
export interface BoardStackStageView {
  /** 0-based. */
  position: number;
  title: string;
  cards: number[];
}

/**
 * #652: Run stack. `running` starts the queued cards as they become ready,
 * within the project's `maxRunning`; `paused` waits for a person after a
 * refused start or a failed round; `stopped` had its queue removed; `done`
 * started every card it queued.
 */
export const STACK_RUN_STATES = [
  'running',
  'paused',
  'stopped',
  'done',
] as const;
export type StackRunState = (typeof STACK_RUN_STATES)[number];

/**
 * #652: a card of a stack run — `queued` ready to start when a slot frees,
 * `waiting` for a dependency, `running` started by the run and still active,
 * `paused` the card whose refused start or failed round paused the run.
 */
export type StackCardRunState = 'queued' | 'waiting' | 'running' | 'paused';

/** #652: why a stack run paused. */
export interface StackRunPause {
  /** A refused start's `BoardErrorCode`, `round_failed`, or `unknown`. */
  code: BoardErrorCode | 'round_failed' | 'unknown';
  /** At most 500 characters. */
  message: string;
  /** The card that paused it; `null` once that card is gone. */
  card: number | null;
  at: string;
}

/** #652: a stack's run, as its face and its page show it. */
export interface StackRunView {
  state: StackRunState;
  pause: StackRunPause | null;
  /** Cards ready to start, in the queue. */
  queued: number;
  /** Queued cards that wait for a dependency. */
  waiting: number;
  /** Cards the run started whose round is still active. */
  running: number;
  startedAt: string;
}

/** One stack on the board (`BoardView.stacks`). */
export interface BoardStackView {
  id: string;
  number: number;
  /** `S-<number>`. */
  label: string;
  title: string;
  /** The column of its least advanced unfinished card; Completed when all are. */
  column: BoardColumn;
  /** Cards in Completed. */
  accepted: number;
  total: number;
  /** The first stage with a card not in Completed; null once all are. */
  currentStage: number | null;
  stages: BoardStackStageView[];
  /** The shared design; null when the stack has none. */
  design: TaskDesignSummary | null;
  /** Sum over its cards, a decimal string; null when nothing is priced. */
  costUsd: string | null;
  /** #652: Run stack's state; `null` before the stack has been run. */
  run: StackRunView | null;
}

/** One card of a stack, as the stack page lists it. */
export interface StackCardView {
  number: number;
  label: string;
  title: string;
  column: BoardColumn;
  round: CardRoundBrief | null;
  /** The card's own design, kept apart from the stack's. */
  design: TaskDesignSummary | null;
  /** #636: the card's latest PR; `null` before it has one. */
  prNumber: number | null;
  prUrl: string | null;
  /** #636: where the card's PR goes — "into C-1's branch" or the base. */
  prTarget: CardPrTarget | null;
  /** The cards of the stage before, by number: "after C-88, C-89". */
  after: number[];
  costUsd: string | null;
  /** #652: the card in the stack run; `null` when the run holds it no more. */
  run: StackCardRunState | null;
}

/** `GET /projects/:projectId/board/stacks/:number`. */
export interface BoardStackDetail
  extends Omit<BoardStackView, 'stages' | 'design'> {
  /** Markdown. */
  body: string;
  stages: (Omit<BoardStackStageView, 'cards'> & {
    cards: StackCardView[];
  })[];
  design: TaskDesignSummary | null;
  /** Any card of the stack has had a round: stages no longer reorder. */
  started: boolean;
  /** The intake it came from; null when made by hand. */
  planId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** C-377: a stage's new title, by its 0-based position; empty clears it. */
export interface StackStageTitle {
  position: number;
  title: string;
}

/**
 * `PATCH …/board/stacks/:number` (operator). `stages` renames stages; a
 * position that is not a stage of the stack refuses the whole change
 * (`stack_refused`).
 */
export interface UpdateBoardStackRequest {
  title?: string;
  body?: string;
  stages?: StackStageTitle[];
}

/**
 * `POST …/board/stacks/:number/cards` (operator): adds a card of the project
 * that is in no stack to a stage — an existing one, or a new last stage
 * (`stage` = the number of stages). Its stage dependencies are written.
 */
export interface AddStackCardRequest {
  card: number;
  stage: number;
}

/**
 * `POST …/board/stacks` (operator, #588): groups cards of the project into a
 * new stack by hand — one stage, no dependencies between its cards, so each
 * still runs on its own. Refused whole with `stack_refused` (409, the cards
 * that broke a rule in `cards`) when any is in Inbox, in a stack already or
 * not a card of the project.
 */
export interface CreateBoardStackRequest {
  title: string;
  /** Markdown; empty when left out. */
  body?: string;
  /** A shared design holds Run of every card until it is approved; off by default. */
  design?: boolean;
  /** Card numbers, at least `MANUAL_STACK_CARDS_MIN`. */
  cards: number[];
}

/** #652: what a stack run says of itself — "Running · 2 queued". */
export const stackRunText = (run: StackRunView): string => {
  const parts = [
    run.running > 0 ? `${run.running} running` : null,
    run.queued > 0 ? `${run.queued} queued` : null,
    run.waiting > 0 ? `${run.waiting} waiting for a dependency` : null,
  ].filter((p) => p !== null);
  const head =
    run.state === 'running'
      ? 'Running'
      : run.state === 'paused'
        ? 'Paused'
        : run.state === 'stopped'
          ? 'Stopped'
          : 'Done';
  return parts.length > 0 ? `${head} · ${parts.join(' · ')}` : head;
};

/** A stack made by hand groups two cards or more. */
export const MANUAL_STACK_CARDS_MIN = 2;

/** `BOARD_COLUMNS` order: how far a card is. */
const columnRank = (column: BoardColumn): number =>
  BOARD_COLUMNS.indexOf(column);

/**
 * The column a collapsed stack sits in: that of its least advanced card not in
 * Completed; Completed when every card is. To Do for an empty stack.
 */
export const stackColumn = (columns: readonly BoardColumn[]): BoardColumn => {
  const open = columns.filter((c) => c !== 'completed');
  if (open.length === 0) return columns.length > 0 ? 'completed' : 'todo';
  return open.reduce((least, c) =>
    columnRank(c) < columnRank(least) ? c : least,
  );
};

/** The first stage with a card not in Completed; null once every card is. */
export const currentStage = (
  stages: readonly { position: number; columns: readonly BoardColumn[] }[],
): number | null => {
  for (const stage of [...stages].sort((a, b) => a.position - b.position)) {
    if (stage.columns.some((c) => c !== 'completed')) return stage.position;
  }
  return null;
};

/**
 * The dependencies stages imply: every card of stage N+1 on every card of
 * stage N, as `[card, dependsOn]` pairs of whatever ids the stages hold.
 * Empty stages are skipped, so the next non-empty stage waits on the last
 * non-empty one.
 */
export const stageLinks = <T>(stages: readonly (readonly T[])[]): [T, T][] => {
  const filled = stages.filter((s) => s.length > 0);
  const links: [T, T][] = [];
  for (let i = 1; i < filled.length; i += 1) {
    for (const card of filled[i]) {
      for (const before of filled[i - 1]) links.push([card, before]);
    }
  }
  return links;
};

/** "Stage 1 of 2 · Components" — a stack face's current stage. */
export const stackStageText = (stack: BoardStackView): string => {
  if (stack.currentStage === null) return 'Every stage done';
  const stage = stack.stages.find((s) => s.position === stack.currentStage);
  const name = stage?.title.trim();
  return `Stage ${stack.currentStage + 1} of ${stack.stages.length}${name ? ` · ${name}` : ''}`;
};

/** A stack's design is needed and not approved: its cards do not run. */
export const isStackGated = (
  design: Pick<TaskDesignSummary, 'needed' | 'status'> | null,
): boolean => design?.needed === true && design.status !== 'approved';

/** The cards of a stack the board shows inside its collapsed face: those in its column. */
export const foldedIntoStack = (
  card: Pick<BoardCardView, 'column'>,
  stack: Pick<BoardStackView, 'column'>,
): boolean => card.column === stack.column;
