import { CARD_RUN_PROMPT_MAX_BYTES } from '../protocol/commands/cards';
import { cardLabel } from './naming';
import type { BoardCardKind } from './types';

/**
 * D17: the card worker's prompt. Fixed, versioned code — not cs-worker, not
 * editable (ADR-0024 scopes ADR-0005). A change to the text bumps
 * `CARD_WORKER_PROMPT_VERSION`, which the API records on each round's run.
 */
export const CARD_WORKER_PROMPT_VERSION = 2;

/** The MCP tool the worker calls when done (D6). */
export const FINISH_CARD_TOOL = 'finish_card';

/** #243 D7: the addressed comment bodies the `## Design` section carries, in UTF-8 bytes. */
export const CARD_DESIGN_COMMENTS_MAX_BYTES = 4 * 1024;

/** #243 D7: the card's approved design, committed by the runner before round 1. */
export interface CardWorkerDesign {
  /** Repository-relative, from `cardDesignPath`. */
  path: string;
  /** The approved revision's rationale. */
  rationale: string;
  /** Bodies of the comments a revision addressed, oldest first. */
  comments: string[];
}

export interface CardWorkerPromptInput {
  number: number;
  title: string;
  /** Markdown, at most `BOARD_CARD_BODY_MAX` characters. */
  body: string;
  kind: BoardCardKind;
  branch: string;
  base: string;
  /** Repository-relative; the spec the runner committed first (D2). */
  specPath: string | null;
  issueNumber: number | null;
  /** #243: the approved design; `null` when the card has none. */
  design: CardWorkerDesign | null;
}

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

/** `text` cut at a code point to at most `max` UTF-8 bytes, `…` included. */
const cutToBytes = (text: string, max: number): string => {
  if (utf8Bytes(text) <= max) return text;
  const room = max - utf8Bytes('…');
  if (room <= 0) return '';
  let kept = '';
  let used = 0;
  for (const ch of text) {
    const size = utf8Bytes(ch);
    if (used + size > room) break;
    kept += ch;
    used += size;
  }
  return `${kept.trimEnd()}…`;
};

/**
 * The addressed comments as list items, oldest first, while they fit in
 * `budget` bytes; the rest are counted, never cut mid-text.
 */
const designCommentLines = (comments: string[], budget: number): string[] => {
  const lines: string[] = [];
  let used = 0;
  for (const [i, comment] of comments.entries()) {
    const line = `- ${comment.trim().replace(/\s*\n\s*/g, ' ')}`;
    const size = utf8Bytes(line) + 1;
    if (used + size > budget) {
      lines.push(`- (${comments.length - i} more not shown)`);
      break;
    }
    lines.push(line);
    used += size;
  }
  return lines;
};

/** #243 D7: what the approved mockup binds, and the decisions behind it. */
const designSection = (
  path: string,
  rationale: string,
  comments: string[],
  commentBudget: number,
): string[] => {
  const lines = [
    '## Design',
    '',
    `The approved mockup is ${path} (already committed on this branch — open it first).`,
    "It binds the layout, the states and the copy. It is not code to copy: build it with the project's real components.",
  ];
  if (rationale) lines.push('', `Why this design: ${rationale}`);
  if (comments.length > 0) {
    lines.push(
      '',
      'Decisions from the design review:',
      ...designCommentLines(comments, commentBudget),
    );
  }
  return lines;
};

/**
 * Round 1 (D5): the card, where to work, how to finish — and, with a design
 * (#243 D7), a `## Design` section. The prompt always fits `card.run`
 * (`CARD_RUN_PROMPT_MAX_BYTES`): when a long body leaves no room, the
 * review comments go first, then the rationale is cut; the card itself and
 * the mockup's path are never shortened.
 */
export const cardWorkerPrompt = (card: CardWorkerPromptInput): string => {
  const { design } = card;
  if (design === null) return assemblePrompt(card, null);
  let rationale = design.rationale.trim();
  let commentBudget = CARD_DESIGN_COMMENTS_MAX_BYTES;
  for (;;) {
    const prompt = assemblePrompt(
      card,
      designSection(design.path, rationale, design.comments, commentBudget),
    );
    const over = utf8Bytes(prompt) - CARD_RUN_PROMPT_MAX_BYTES;
    if (over <= 0) return prompt;
    if (commentBudget > 0) {
      commentBudget = Math.max(0, commentBudget - over);
    } else if (rationale) {
      rationale = cutToBytes(rationale, utf8Bytes(rationale) - over);
    } else {
      return prompt;
    }
  }
};

const assemblePrompt = (
  card: CardWorkerPromptInput,
  design: string[] | null,
): string => {
  const label = cardLabel(card.number);
  const lines = [
    `You are the dedicated worker for AgentDock board card ${label}: ${card.title}`,
    '',
    `Kind: ${card.kind === 'bug' ? 'bug fix' : 'feature'}`,
    `Branch: ${card.branch} (based on ${card.base})`,
  ];
  if (card.issueNumber !== null) {
    lines.push(`GitHub issue: #${card.issueNumber}`);
  }
  if (card.specPath !== null) {
    lines.push(
      `Specification: ${card.specPath} (already committed on this branch — read it first)`,
    );
  }
  lines.push('', '## The card', '', card.body.trim() || '(no description)', '');
  if (design !== null) lines.push(...design, '');
  lines.push(
    '## How to work',
    '',
    '- Work only in this worktree and on this branch. Do not switch branches or touch other worktrees.',
    "- Follow the repository's CLAUDE.md / AGENTS.md.",
    '- Commit your work as you go, with clear messages.',
    '- Run the tests and checks the repository defines before you finish.',
    '- Do not push and do not open a pull request: AgentDock does that when the card is finished.',
    '- If something is unclear, ask in this session and wait for the person.',
    '',
    '## When you are done',
    '',
    `Call the \`${FINISH_CARD_TOOL}\` tool with a short summary of what you changed and how you checked it.`,
    `If the \`${FINISH_CARD_TOOL}\` tool is not available, reply with the summary followed by the single word DONE, and stop.`,
  );
  return lines.join('\n');
};

/** D9: the prompt of a feedback round, resuming the same session. */
export const cardFeedbackPrompt = (feedback: string): string =>
  `Review feedback: ${feedback.trim()}\n\nAddress it on the same branch, commit, then call ${FINISH_CARD_TOOL}.`;

/** A retry after a failed, ended or cancelled round resumes with this. */
export const CARD_CONTINUE_PROMPT = 'continue';
