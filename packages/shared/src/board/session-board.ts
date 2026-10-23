import type { LocalBoardWaitEvent } from '../protocol/local';
import type { PendingQuestion } from '../session-message/contracts';
import { cardLabel } from './naming';
import {
  BOARD_COLUMNS,
  type BoardColumn,
  CARD_CI_STATES,
  CARD_ROUND_PHASES,
  type CardCiState,
  type CardRoundPhase,
  isActiveRoundPhase,
} from './types';

/**
 * #845 D8 (ADR-0083): `board.wait` is a diff, not a queue. The cursor is a
 * snapshot of the fields the conductor waits on, card by card; the server
 * compares it with the board now and reports what differs. So the same
 * cursor twice reports the same changes, a lost answer loses nothing, and the
 * cursor outlives the session's context. The in-process `board.changed`
 * signal only wakes a held request early; it carries nothing the diff needs.
 */

/** What `board.wait` watches on one card, read by the API. */
export interface BoardWatchCard {
  number: number;
  /** `C-<number>`. */
  label: string;
  title: string;
  column: BoardColumn;
  /** The latest round's number; `null` before the first Run. */
  round: number | null;
  roundPhase: CardRoundPhase | null;
  ciState: CardCiState;
  /** The latest PR merged (`mergedAt` set or `prState` `merged`). */
  merged: boolean;
  prNumber: number | null;
  /** The question selector the latest round's session shows, if any. */
  question: PendingQuestion | null;
}

/** One card of a cursor: the watched fields only, the question by its key. */
export interface BoardWatchEntry {
  column: BoardColumn;
  round: number | null;
  roundPhase: CardRoundPhase | null;
  ciState: CardCiState;
  merged: boolean;
  questionKey: string | null;
}

export interface BoardWatchSnapshot {
  projectId: string;
  cards: Map<number, BoardWatchEntry>;
}

const CURSOR_VERSION = 'b1';
const FIELD = ',';
const CARD = ';';
const PART = '.';

/** Project ids are cuids; anything that could split the cursor is refused. */
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const QUESTION_KEY = /^[0-9a-f]{16}$/;

const indexOf = (list: readonly string[], value: string | null): string =>
  value === null ? '' : String(list.indexOf(value));

const valueAt = <T extends string>(
  list: readonly T[],
  raw: string,
): T | null | undefined => {
  if (raw === '') return null;
  if (!/^\d{1,2}$/.test(raw)) return undefined;
  return list[Number(raw)];
};

const entryOf = (card: BoardWatchCard): BoardWatchEntry => ({
  column: card.column,
  round: card.round,
  roundPhase: card.roundPhase,
  ciState: card.ciState,
  merged: card.merged,
  questionKey: card.question?.key ?? null,
});

/**
 * The cursor for `cards` as they are now. Compact plain text — about 20
 * characters a card, so a board of a thousand open cards stays far below
 * `LOCAL_BOARD_WAIT_CURSOR_MAX`. Opaque to every reader but `decode`.
 */
export const encodeBoardWaitCursor = (
  projectId: string,
  cards: readonly BoardWatchCard[],
): string => {
  if (!PROJECT_ID.test(projectId)) throw new Error('invalid project id');
  const entries = [...cards]
    .sort((a, b) => a.number - b.number)
    .map((card) => {
      const entry = entryOf(card);
      return [
        card.number,
        indexOf(BOARD_COLUMNS, entry.column),
        entry.round ?? '',
        indexOf(CARD_ROUND_PHASES, entry.roundPhase),
        indexOf(CARD_CI_STATES, entry.ciState),
        entry.merged ? '1' : '0',
        entry.questionKey ?? '',
      ].join(FIELD);
    });
  return [CURSOR_VERSION, projectId, entries.join(CARD)].join(PART);
};

const decodeEntry = (raw: string): [number, BoardWatchEntry] | null => {
  const fields = raw.split(FIELD);
  if (fields.length !== 7) return null;
  const [n, col, round, phase, ci, merged, question] = fields;
  if (!/^[1-9]\d{0,8}$/.test(n)) return null;
  const column = valueAt(BOARD_COLUMNS, col);
  const roundPhase = valueAt(CARD_ROUND_PHASES, phase);
  const ciState = valueAt(CARD_CI_STATES, ci);
  if (!column || roundPhase === undefined || !ciState) return null;
  if (round !== '' && !/^[1-9]\d{0,5}$/.test(round)) return null;
  if (merged !== '0' && merged !== '1') return null;
  if (question !== '' && !QUESTION_KEY.test(question)) return null;
  return [
    Number(n),
    {
      column,
      round: round === '' ? null : Number(round),
      roundPhase,
      ciState,
      merged: merged === '1',
      questionKey: question === '' ? null : question,
    },
  ];
};

/**
 * The snapshot a cursor carries; `null` when it is malformed or another
 * project's — the server then answers as to a call without a cursor (at
 * once, no events, a fresh cursor).
 */
export const decodeBoardWaitCursor = (
  cursor: string,
  projectId: string,
): BoardWatchSnapshot | null => {
  const parts = cursor.split(PART);
  if (parts.length !== 3) return null;
  const [version, project, body] = parts;
  if (version !== CURSOR_VERSION || project !== projectId) return null;
  const cards = new Map<number, BoardWatchEntry>();
  if (body !== '') {
    for (const raw of body.split(CARD)) {
      const entry = decodeEntry(raw);
      if (!entry || cards.has(entry[0])) return null;
      cards.set(entry[0], entry[1]);
    }
  }
  return { projectId, cards };
};

/**
 * The changes from `prior` to `current`, in card number order and, per card,
 * column → round ended → CI → merged → question; deleted cards last, with an
 * empty title. `current` must hold every
 * card the wait watches **and** every card of `prior` that still exists, so
 * a card that left the watched columns reports where it went; a `prior` card
 * missing from `current` was deleted (`to: null`), a `current` card missing
 * from `prior` appeared (`from: null`).
 */
export const diffBoardWatch = (
  prior: BoardWatchSnapshot,
  current: readonly BoardWatchCard[],
): LocalBoardWaitEvent[] => {
  const events: LocalBoardWaitEvent[] = [];
  const sorted = [...current].sort((a, b) => a.number - b.number);
  const present = new Set(sorted.map((card) => card.number));
  for (const card of sorted) {
    const base = { card: card.number, label: card.label, title: card.title };
    const before = prior.cards.get(card.number);
    if (!before) {
      events.push({ type: 'column', ...base, from: null, to: card.column });
      if (card.question) {
        events.push({ type: 'question', ...base, question: card.question });
      }
      continue;
    }
    if (before.column !== card.column) {
      events.push({
        type: 'column',
        ...base,
        from: before.column,
        to: card.column,
      });
    }
    if (before.round !== null && isActiveRoundPhase(before.roundPhase)) {
      const sameRound = card.round === before.round;
      if (!sameRound || !isActiveRoundPhase(card.roundPhase)) {
        events.push({
          type: 'round_ended',
          ...base,
          round: before.round,
          phase: sameRound ? card.roundPhase : null,
        });
      }
    }
    if (before.ciState !== card.ciState) {
      events.push({
        type: 'ci',
        ...base,
        from: before.ciState,
        to: card.ciState,
      });
    }
    if (!before.merged && card.merged) {
      events.push({ type: 'pr_merged', ...base, prNumber: card.prNumber });
    }
    if (card.question && card.question.key !== before.questionKey) {
      events.push({ type: 'question', ...base, question: card.question });
    }
  }
  const deleted = [...prior.cards.entries()]
    .filter(([number]) => !present.has(number))
    .sort(([a], [b]) => a - b);
  for (const [number, before] of deleted) {
    events.push({
      type: 'column',
      card: number,
      label: cardLabel(number),
      title: '',
      from: before.column,
      to: null,
    });
  }
  return events;
};
