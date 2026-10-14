import { cardLabel } from './naming';
import type { BoardCardKind } from './types';

/**
 * D17: the card worker's prompt. Fixed, versioned code — not cs-worker, not
 * editable (ADR-0024 scopes ADR-0005). A change to the text bumps
 * `CARD_WORKER_PROMPT_VERSION`, which the API records on each round's run.
 */
export const CARD_WORKER_PROMPT_VERSION = 1;

/** The MCP tool the worker calls when done (D6). */
export const FINISH_CARD_TOOL = 'finish_card';

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
}

/** Round 1 (D5): the card, where to work, how to finish. */
export const cardWorkerPrompt = (card: CardWorkerPromptInput): string => {
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
  lines.push(
    '',
    '## The card',
    '',
    card.body.trim() || '(no description)',
    '',
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
