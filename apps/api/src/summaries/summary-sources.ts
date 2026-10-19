import { createHash } from 'node:crypto';
import { cardCiChecksOf } from '@agentdock/shared';
import type {
  BoardCardKind,
  BoardColumn,
  CardCiState,
  CardPrState,
  CardRoundPhase,
  CardRoundTrigger,
  SessionContentKind,
} from '@prisma/client';

/**
 * What a summary is made from (#658), as the text the model reads. The same
 * stored rows always give the same text, so its hash says whether the source
 * changed since the cached summary was made. Nothing here reads a project's
 * files (ADR-0001): a card is its stored fields and rounds, a session its
 * stored, redacted content (ADR-0021).
 */

/** A card's description, a round's summary: cut to this many characters. */
const FIELD_MAX = 3_000;
/** One session content row. */
const CONTENT_ROW_MAX = 2_000;
/** A tool's input or output says what it did; the rest is noise. */
const TOOL_ROW_MAX = 300;
/** The whole session text the model reads. */
const SESSION_MAX = 60_000;
/** The latest rounds a card summary reads. */
export const CARD_ROUNDS_READ = 5;

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

export const sourceHash = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

export interface CardSourceRow {
  number: number;
  title: string;
  body: string;
  kind: BoardCardKind;
  column: BoardColumn;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  prState: CardPrState | null;
  prBase: string | null;
  ciState: CardCiState;
  ciChecks: unknown;
  ciFixAttempts: number;
  needsPerson: boolean;
  needsPersonReason: string | null;
  mergedAt: Date | null;
  /** Newest first, at most `CARD_ROUNDS_READ`. */
  rounds: {
    round: number;
    trigger: CardRoundTrigger;
    phase: CardRoundPhase;
    feedback: string | null;
    summary: string | null;
    error: string | null;
  }[];
}

const COLUMN: Record<BoardColumn, string> = {
  inbox: 'Inbox',
  todo: 'To do',
  in_progress: 'In progress',
  finished: 'Finished (waiting for a person to accept it)',
  completed: 'Completed',
};

/** What the review state is, from what the API stores of the card and its PR. */
const reviewOf = (card: CardSourceRow): string => {
  if (card.prState === 'merged') return 'merged';
  if (card.prState === 'closed') return 'closed without merging';
  if (card.prState === null) return 'no pull request yet';
  if (card.prState === 'draft')
    return 'draft pull request, not ready for review';
  if (card.column === 'finished')
    return 'waiting for a person to review and accept it';
  if (card.column === 'in_progress') return 'the agent is still working on it';
  return 'open';
};

const ciOf = (card: CardSourceRow): string => {
  if (card.prNumber === null) return 'no pull request';
  if (card.ciState === 'none') return 'no checks reported';
  if (card.ciState === 'pending') return 'checks running';
  if (card.ciState === 'green') return 'all checks passed';
  const failed = cardCiChecksOf(card.ciChecks).map((c) => c.name);
  const fixes =
    card.ciFixAttempts > 0 ? `; ${card.ciFixAttempts} fix rounds tried` : '';
  return failed.length > 0
    ? `failing: ${failed.join(', ')}${fixes}`
    : `failing${fixes}`;
};

/** The card and its pull request: changes, CI, review state and what remains. */
export const cardSource = (card: CardSourceRow): string => {
  const lines = [
    `Card C-${card.number} (${card.kind}): ${card.title}`,
    `Column: ${COLUMN[card.column]}`,
    `Description:\n${clip(card.body.trim() || '(none)', FIELD_MAX)}`,
    card.prNumber !== null
      ? `Pull request: #${card.prNumber}${card.prUrl ? ` ${card.prUrl}` : ''}${
          card.prBase ? `, into ${card.prBase}` : ''
        }${card.branch ? `, from ${card.branch}` : ''}`
      : 'Pull request: none',
    `CI: ${ciOf(card)}`,
    `Review state: ${reviewOf(card)}`,
    ...(card.needsPerson
      ? [`Needs a person: ${card.needsPersonReason ?? 'yes'}`]
      : []),
    'Rounds, newest first:',
    ...(card.rounds.length === 0
      ? ['(no worker has run yet)']
      : card.rounds.map((round) =>
          [
            `- Round ${round.round} (${round.trigger}), ${round.phase}`,
            round.feedback
              ? `  Feedback it was given: ${clip(round.feedback, FIELD_MAX)}`
              : null,
            round.summary
              ? `  The worker's summary: ${clip(round.summary, FIELD_MAX)}`
              : null,
            round.error ? `  Error: ${clip(round.error, FIELD_MAX)}` : null,
          ]
            .filter((line) => line !== null)
            .join('\n'),
        )),
  ];
  return lines.join('\n');
};

export interface SessionSourceRow {
  title: string | null;
  gitBranch: string | null;
  startedAt: Date;
  endedAt: Date | null;
  /** Oldest first. */
  content: {
    kind: SessionContentKind;
    toolName: string | null;
    text: string;
  }[];
}

const contentLine = (row: SessionSourceRow['content'][number]): string => {
  switch (row.kind) {
    case 'prompt':
      return `[person] ${clip(row.text, CONTENT_ROW_MAX)}`;
    case 'response':
      return `[agent] ${clip(row.text, CONTENT_ROW_MAX)}`;
    case 'tool_input':
      return `[tool ${row.toolName ?? '?'}] ${clip(row.text, TOOL_ROW_MAX)}`;
    case 'tool_output':
      return `[result ${row.toolName ?? '?'}] ${clip(row.text, TOOL_ROW_MAX)}`;
  }
};

/**
 * The session's stored content as a transcript. Over `SESSION_MAX` the first
 * prompt stays and the oldest of the rest are dropped: how it started and how
 * it stands matter most.
 */
export const sessionSource = (session: SessionSourceRow): string => {
  const head = [
    `Session: ${session.title ?? '(untitled)'}`,
    session.gitBranch ? `Branch: ${session.gitBranch}` : null,
    `Started: ${session.startedAt.toISOString()}`,
    session.endedAt
      ? `Ended: ${session.endedAt.toISOString()}`
      : 'Still running',
    'Transcript, oldest first:',
  ]
    .filter((line) => line !== null)
    .join('\n');
  const lines = session.content.map(contentLine);
  const whole = [head, ...lines].join('\n');
  if (whole.length <= SESSION_MAX) return whole;
  const firstPrompt = session.content.findIndex((r) => r.kind === 'prompt');
  let budget = SESSION_MAX - head.length;
  const kept: string[] = [];
  const pinned = firstPrompt >= 0 ? lines[firstPrompt] : null;
  if (pinned) budget -= pinned.length + 1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (i === firstPrompt) continue;
    if (lines[i].length + 1 > budget) break;
    budget -= lines[i].length + 1;
    kept.unshift(lines[i]);
  }
  const dropped = lines.length - kept.length - (pinned ? 1 : 0);
  return [
    head,
    ...(pinned ? [pinned] : []),
    ...(dropped > 0 ? [`(${dropped} earlier entries left out)`] : []),
    ...kept,
  ].join('\n');
};
