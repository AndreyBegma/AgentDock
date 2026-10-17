import type { TaskDesignSummary } from '../design/contracts';
import type { BoardCardView, CardRoundBrief } from './contracts';
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
  /** The cards of the stage before, by number: "after C-88, C-89". */
  after: number[];
  costUsd: string | null;
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

/** `PATCH …/board/stacks/:number` (operator). */
export interface UpdateBoardStackRequest {
  title?: string;
  body?: string;
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
