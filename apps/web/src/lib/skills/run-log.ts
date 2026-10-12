import type { RunLogFrame, RunLogLine } from '@agentdock/shared/protocol';

/** Lines kept in memory; a long run drops its oldest rendered lines. */
export const RUN_LOG_KEEP_LINES = 5000;

export interface RunLogRow extends RunLogLine {
  /** Monotonic, so a dropped head never renumbers the rows after it. */
  id: number;
}

export interface RunLogState {
  rows: RunLogRow[];
  nextId: number;
  /** The run reached a terminal phase; the lines stay. */
  endedPhase: string | null;
  /** The lines were cut at the head to stay within `RUN_LOG_KEEP_LINES`. */
  trimmed: boolean;
  /** The next backlog frame starts a new replay and replaces `rows`; the ones after it append. */
  awaitingBacklog: boolean;
}

export const EMPTY_RUN_LOG: RunLogState = {
  rows: [],
  nextId: 0,
  endedPhase: null,
  trimmed: false,
  awaitingBacklog: true,
};

const append = (state: RunLogState, lines: RunLogLine[]): RunLogState => {
  const added = lines.map((line, i) => ({ ...line, id: state.nextId + i }));
  const all = [...state.rows, ...added];
  const over = all.length - RUN_LOG_KEEP_LINES;
  return {
    ...state,
    rows: over > 0 ? all.slice(over) : all,
    nextId: state.nextId + added.length,
    trimmed: state.trimmed || over > 0,
  };
};

/**
 * One frame onto the log. A backlog frame arrives on every (re)subscription
 * and replays what was rendered before; the first one after a reset replaces
 * the rows and later backlog frames of the same replay append, so a reconnect
 * does not duplicate lines. Live frames append.
 */
export function applyRunLogFrame(
  state: RunLogState,
  frame: RunLogFrame,
): RunLogState {
  if (frame.type === 'ended') return { ...state, endedPhase: frame.phase };
  if (frame.backlog) {
    const base = state.awaitingBacklog ? EMPTY_RUN_LOG : state;
    return { ...append(base, frame.lines), awaitingBacklog: false };
  }
  return append({ ...state, awaitingBacklog: false }, frame.lines);
}

/** Called on a reconnect: the next backlog frame starts the log over. */
export const beginReplay = (state: RunLogState): RunLogState => ({
  ...state,
  awaitingBacklog: true,
});

export const RUN_LOG_KIND_PREFIX: Record<RunLogLine['kind'], string> = {
  assistant: '',
  tool: '› ',
  result: '✓ ',
  system: '· ',
};

/** The text of a row as the log viewer shows it. */
export const rowText = (row: RunLogLine): string =>
  `${RUN_LOG_KIND_PREFIX[row.kind]}${row.text}`;
