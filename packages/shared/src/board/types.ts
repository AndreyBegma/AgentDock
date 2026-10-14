import { LOCAL_CARD_SUMMARY_MAX } from '../protocol/local';

/**
 * The project Board (issue #242, ADR-0024): cards AgentDock owns, each worked
 * by a dedicated interactive Claude Code worker outside the orchestrator. The
 * enums mirror the Prisma enums of the same names.
 */

/** D3. `inbox` arrives with auto-capture (#244). */
export const BOARD_COLUMNS = [
  'todo',
  'in_progress',
  'finished',
  'completed',
] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export const isBoardColumn = (value: string): value is BoardColumn =>
  (BOARD_COLUMNS as readonly string[]).includes(value);

/** Decides the branch prefix (`feat` / `fix`) and the issue label. */
export const BOARD_CARD_KINDS = ['feature', 'bug'] as const;
export type BoardCardKind = (typeof BOARD_CARD_KINDS)[number];

/** Where a card came from; `manual` only until #244. */
export const BOARD_CARD_SOURCES = ['manual'] as const;
export type BoardCardSource = (typeof BOARD_CARD_SOURCES)[number];

/** D4: what started a round. */
export const CARD_ROUND_TRIGGERS = ['run', 'feedback'] as const;
export type CardRoundTrigger = (typeof CARD_ROUND_TRIGGERS)[number];

/**
 * D4/D6: a round's phase. `waiting` is Claude waiting for the person
 * (`hook.stopped`); `finished` is done (worker, session end or the person);
 * `ended` is a session that exited without being finished first.
 */
export const CARD_ROUND_PHASES = [
  'queued',
  'starting',
  'running',
  'waiting',
  'finished',
  'ended',
  'failed',
  'cancelled',
] as const;
export type CardRoundPhase = (typeof CARD_ROUND_PHASES)[number];

/** D7: a round in one of these phases holds the card in In progress. */
export const ACTIVE_CARD_ROUND_PHASES = [
  'queued',
  'starting',
  'running',
  'waiting',
] as const satisfies readonly CardRoundPhase[];
export type ActiveCardRoundPhase = (typeof ACTIVE_CARD_ROUND_PHASES)[number];

export const isActiveRoundPhase = (
  phase: CardRoundPhase | null | undefined,
): phase is ActiveCardRoundPhase =>
  phase != null &&
  (ACTIVE_CARD_ROUND_PHASES as readonly CardRoundPhase[]).includes(phase);

/** D6: who finished a round, in the order the API trusts them. */
export const CARD_FINISHED_BY = ['worker', 'session_end', 'person'] as const;
export type CardFinishedBy = (typeof CARD_FINISHED_BY)[number];

export const BOARD_CARD_TITLE_MAX = 200;
/** Markdown. */
export const BOARD_CARD_BODY_MAX = 20_000;
export const CARD_FEEDBACK_MAX = 8_000;
/** The `finish_card` summary (D6), as the `card.finish` local method bounds it. */
export const CARD_SUMMARY_MAX = LOCAL_CARD_SUMMARY_MAX;

/** D13: active rounds per project. */
export const BOARD_MAX_RUNNING_DEFAULT = 3;
export const BOARD_MAX_RUNNING_MIN = 1;
export const BOARD_MAX_RUNNING_MAX = 10;

/** `GET /board` lists the newest Completed cards in pages of this size. */
export const BOARD_COMPLETED_PAGE_SIZE = 50;

/** D6: with no hook event this long after a round starts, the card says "hooks not installed". */
export const CARD_HOOKS_GRACE_MS = 2 * 60 * 1000;

/** D6: how often the runner checks that a card's tmux session is alive. */
export const CARD_SESSION_POLL_MS = 10_000;
