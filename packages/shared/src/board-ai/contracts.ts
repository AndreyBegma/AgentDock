import type { BoardCardKind, BoardColumn } from '../board/types';

/** #660: the longest question Ask the Board takes. */
export const BOARD_ASK_QUESTION_MAX = 500;

/** Items one answer links to, at most. */
export const BOARD_ASK_HITS_MAX = 20;

/** What a question may search. */
export const BOARD_ASK_SOURCES = ['cards', 'prs', 'activity'] as const;
export type BoardAskSource = (typeof BOARD_ASK_SOURCES)[number];

/** PR states a question may filter on. */
export const BOARD_ASK_PR_STATES = ['open', 'merged', 'closed'] as const;
export type BoardAskPrState = (typeof BOARD_ASK_PR_STATES)[number];

/** Check states a question may filter on. */
export const BOARD_ASK_CHECKS = ['failed', 'passed', 'pending'] as const;
export type BoardAskChecks = (typeof BOARD_ASK_CHECKS)[number];

/**
 * #660: the structured query a question is turned into. Every field narrows;
 * an empty list or null does not. Project names are matched against the
 * projects the person can access, never anything else.
 */
export interface BoardAskQuery {
  /** Display names, `owner/name` or repository names; empty is every project. */
  projects: string[];
  /** Words a match must contain, in English (stored text is English). */
  text: string[];
  columns: BoardColumn[];
  kind: BoardCardKind | null;
  prState: BoardAskPrState | null;
  checks: BoardAskChecks | null;
  /** Created (cards) or happened (activity) within this many days. */
  withinDays: number | null;
  sources: BoardAskSource[];
}

export interface BoardAskRequest {
  question: string;
}

export type BoardAskHit =
  | {
      type: 'card';
      projectId: string;
      projectName: string;
      number: number;
      /** `C-<number>`. */
      label: string;
      title: string;
      column: BoardColumn;
      kind: BoardCardKind;
      prNumber: number | null;
      prUrl: string | null;
    }
  | {
      type: 'pr';
      projectId: string;
      projectName: string;
      /** The card the PR belongs to. */
      cardNumber: number;
      number: number;
      title: string;
      state: string | null;
      url: string;
    }
  | {
      type: 'activity';
      projectId: string;
      projectName: string;
      id: string;
      title: string;
      ts: string;
      link: string | null;
    };

/** `POST /board/ask`. */
export interface BoardAskResponse {
  /** The short reply, in the question's language; `[C-12]` and `[PR #34]` name hits. */
  answer: string;
  /** BCP 47 primary language of the question, e.g. `ru`; `und` when unknown. */
  language: string;
  /** What the question was turned into, to show as removable chips. */
  query: BoardAskQuery;
  hits: BoardAskHit[];
}

/**
 * `POST /board/search`: a query run again without a model call — what the
 * dialog sends when the person removes one of its chips.
 */
export interface BoardSearchRequest {
  query: BoardAskQuery;
}

export interface BoardSearchResponse {
  hits: BoardAskHit[];
}

/** #660: the three hints a new card may get. */
export const TRIAGE_HINTS = ['duplicates', 'kind', 'priority'] as const;
export type TriageHint = (typeof TRIAGE_HINTS)[number];

/**
 * A priority is the card's place in its column: To Do is the queue, so
 * `high` is its top and `low` its bottom. `normal` is no hint.
 */
export const TRIAGE_PRIORITIES = ['high', 'normal', 'low'] as const;
export type TriagePriority = (typeof TRIAGE_PRIORITIES)[number];

export interface TriageDuplicateView {
  number: number;
  label: string;
  title: string;
  column: BoardColumn;
  reason: string;
}

/**
 * `GET …/board/cards/:number/triage`. `hidden` covers no triage, one still
 * running, one that failed, and the triage provider at its cap: hints are
 * never shown then. A dismissed or applied hint is null.
 */
export interface CardTriageView {
  state: 'pending' | 'ready' | 'hidden';
  duplicates: TriageDuplicateView[] | null;
  kind: { value: BoardCardKind; reason: string } | null;
  priority: { value: Exclude<TriagePriority, 'normal'>; reason: string } | null;
}

/** `GET …/board/triage`: the cards with hints to show, and how many. */
export interface BoardTriageCounts {
  cards: { number: number; hints: number }[];
}

export interface TriageHintRequest {
  hint: TriageHint;
}

/** Error codes of Ask the Board and triage, besides the gateway's `LlmErrorCode`. */
export type BoardAiErrorCode =
  | 'ai_no_model'
  | 'ai_bad_answer'
  | 'triage_not_found'
  | 'triage_hint_gone';
