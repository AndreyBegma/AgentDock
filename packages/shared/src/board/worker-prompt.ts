import type { CardAttachmentBrief } from '../attachments/contracts';
import { ATTACHMENTS_WORKTREE_DIR } from '../attachments/limits';
import { attachmentWorktreePath } from '../attachments/names';
import { attachmentKindLabel } from '../attachments/types';
import { CARD_RUN_PROMPT_MAX_BYTES } from '../protocol/commands/cards';
import { cardLabel } from './naming';
import type { BoardCardKind } from './types';

/**
 * D17: the card worker's prompt. Fixed, versioned code — not cs-worker, not
 * editable (ADR-0024 scopes ADR-0005). A change to the text bumps
 * `CARD_WORKER_PROMPT_VERSION`, which the API records on each round's run.
 * Version 4 (#309 D10): the `## Attachments` sections.
 */
export const CARD_WORKER_PROMPT_VERSION = 4;

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
  /**
   * #309 D10: the card's and its rounds' attachments, in upload order — the
   * same list `card.run` carries. Absent is none.
   */
  attachments?: readonly CardAttachmentBrief[];
}

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

/** `text` cut at a code point to at most `max` UTF-8 bytes, `suffix` included. */
const cutToBytes = (text: string, max: number, suffix = '…'): string => {
  if (utf8Bytes(text) <= max) return text;
  const room = max - utf8Bytes(suffix);
  if (room <= 0) return '';
  let kept = '';
  let used = 0;
  for (const ch of text) {
    const size = utf8Bytes(ch);
    if (used + size > room) break;
    kept += ch;
    used += size;
  }
  return `${kept.trimEnd()}${suffix}`;
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

/** A display name on one line of the prompt. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * #309 D10: one attachment as a list item — its worktree path, its type and,
 * while there is room, its display name.
 */
const attachmentLine = (
  attachment: CardAttachmentBrief,
  withName: boolean,
): string => {
  const path = attachmentWorktreePath(attachment.id, attachment.name);
  const kind = attachmentKindLabel(attachment.mime);
  return withName
    ? `- \`${path}\` (${kind}) — ${oneLine(attachment.name)}`
    : `- \`${path}\` (${kind})`;
};

const OPEN_WITH_READ =
  'Open an image with the Read tool to see it; read PDF and text files the same way.';

/** #309 D10: the files the person attached, already in this worktree. */
const attachmentsSection = (
  attachments: readonly CardAttachmentBrief[],
  withNames: boolean,
): string[] => [
  '## Attachments',
  '',
  `The person attached these files to the card. They are in this worktree under ${ATTACHMENTS_WORKTREE_DIR}/, git-excluded — do not commit or move them.`,
  '',
  ...attachments.map((a) => attachmentLine(a, withNames)),
  '',
  OPEN_WITH_READ,
];

/**
 * Round 1 (D5): the card, where to work, how to finish — and, with a design
 * (#243 D7), a `## Design` section; with attachments (#309 D10), an
 * `## Attachments` section. The prompt always fits `card.run`
 * (`CARD_RUN_PROMPT_MAX_BYTES`): when a long body leaves no room, the
 * review comments go first, then the rationale is cut, then the attachments
 * lose their display names (their paths stay); only a card that still does
 * not fit has its body cut, ending with `CARD_BODY_CUT_SUFFIX`. The mockup's
 * path and the attachments' paths are never shortened.
 */
export const cardWorkerPrompt = (card: CardWorkerPromptInput): string => {
  const { design } = card;
  const attachments = card.attachments ?? [];
  let rationale = design?.rationale.trim() ?? '';
  let commentBudget = design ? CARD_DESIGN_COMMENTS_MAX_BYTES : 0;
  let withNames = attachments.length > 0;
  let body = card.body.trim();
  let bodyCut = false;
  for (;;) {
    const prompt = assemblePrompt(
      card,
      body,
      design
        ? designSection(design.path, rationale, design.comments, commentBudget)
        : null,
      attachments.length > 0
        ? attachmentsSection(attachments, withNames)
        : null,
    );
    const over = utf8Bytes(prompt) - CARD_RUN_PROMPT_MAX_BYTES;
    if (over <= 0) return prompt;
    if (commentBudget > 0) {
      commentBudget = Math.max(0, commentBudget - over);
    } else if (rationale) {
      rationale = cutToBytes(rationale, utf8Bytes(rationale) - over);
    } else if (withNames) {
      withNames = false;
    } else if (body && !bodyCut) {
      body = cutToBytes(body, utf8Bytes(body) - over, CARD_BODY_CUT_SUFFIX);
      bodyCut = true;
    } else {
      return prompt;
    }
  }
};

const assemblePrompt = (
  card: CardWorkerPromptInput,
  body: string,
  design: string[] | null,
  attachments: string[] | null,
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
  lines.push('', '## The card', '', body || '(no description)', '');
  if (design !== null) lines.push(...design, '');
  if (attachments !== null) lines.push(...attachments, '');
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

/** #273 D1: the card text a round's prompt was built from. */
export interface CardText {
  title: string;
  body: string;
  kind: BoardCardKind;
}

export type CardTextField = keyof CardText;

/** #309 D10: attachments added and removed since the last started round. */
export interface CardAttachmentChange {
  /** In the card's upload order. */
  added: CardAttachmentBrief[];
  /** In the snapshot's order. */
  removed: CardAttachmentBrief[];
}

/**
 * #309 D10: the card's attachments when the last started round's prompt was
 * built (`board_card_rounds.cardAttachments`) and now.
 */
export interface CardAttachmentSets {
  before: readonly CardAttachmentBrief[];
  now: readonly CardAttachmentBrief[];
}

/** #273 D1: what changed between the last started round's snapshot and the card now. */
export interface CardChange {
  /**
   * The changed text fields, in `title`, `kind`, `body` order; empty only
   * when just the attachments changed.
   */
  fields: CardTextField[];
  before: CardText;
  now: CardText;
  /** #309 D10: both lists empty when the attachments did not change. */
  attachments: CardAttachmentChange;
}

const CARD_TEXT_FIELDS: readonly CardTextField[] = ['title', 'kind', 'body'];

const attachmentsDiff = ({
  before,
  now,
}: CardAttachmentSets): CardAttachmentChange => {
  const had = new Set(before.map((a) => a.id));
  const has = new Set(now.map((a) => a.id));
  return {
    added: now.filter((a) => !had.has(a.id)),
    removed: before.filter((a) => !has.has(a.id)),
  };
};

/**
 * #273 D1: `null` when the text is the same, surrounding whitespace aside —
 * and (#309 D10) no attachment was added or removed. Without `attachments`
 * the attachments count as unchanged.
 */
export const cardChange = (
  before: CardText,
  now: CardText,
  attachments?: CardAttachmentSets,
): CardChange | null => {
  const fields = CARD_TEXT_FIELDS.filter(
    (field) => before[field].trim() !== now[field].trim(),
  );
  const files = attachments
    ? attachmentsDiff(attachments)
    : { added: [], removed: [] };
  const changed =
    fields.length > 0 || files.added.length > 0 || files.removed.length > 0;
  return changed ? { fields, before, now, attachments: files } : null;
};

export interface CardNextRoundInput {
  /** `C-<number>`. */
  label: string;
  change: CardChange | null;
  /** A feedback round's text, at most `CARD_FEEDBACK_MAX` characters; `null` for a Run. */
  feedback: string | null;
}

/** #273 D4: what a body cut to fit the prompt ends with. */
export const CARD_BODY_CUT_SUFFIX = '… (cut to fit)';

const kindName = (kind: BoardCardKind): string =>
  kind === 'bug' ? 'bug fix' : 'feature';

const changeSection = (
  label: string,
  change: CardChange,
  body: string | null,
): string[] => {
  const { before, now, fields } = change;
  const lines = [
    '## Card changed',
    '',
    `The person edited card ${label} after your last round. The text below replaces what you were given before.`,
    '',
    fields.includes('title')
      ? `Title: ${now.title} (was: ${before.title})`
      : `Title: ${now.title}`,
  ];
  if (fields.includes('kind')) {
    lines.push(`Kind: ${kindName(now.kind)} (was: ${kindName(before.kind)})`);
  }
  if (body !== null) {
    lines.push('', '### What to do', '', body || '(no description)');
  }
  return lines;
};

/** #309 D10: what the person attached or removed since the last round. */
const attachmentChangeSection = (
  label: string,
  { added, removed }: CardAttachmentChange,
): string[] => {
  const lines = [
    '## Attachments changed',
    '',
    `The person changed the attachments of card ${label} after your last round. They are in this worktree under ${ATTACHMENTS_WORKTREE_DIR}/, git-excluded — do not commit or move them.`,
  ];
  if (added.length > 0) {
    lines.push(
      '',
      'Added:',
      ...added.map((a) => attachmentLine(a, true)),
      '',
      OPEN_WITH_READ,
    );
  }
  if (removed.length > 0) {
    lines.push(
      '',
      'Removed (no longer there — disregard them):',
      ...removed.map((a) => `- ${oneLine(a.name)}`),
    );
  }
  return lines;
};

const assembleNextRound = (
  input: CardNextRoundInput & { change: CardChange },
  body: string | null,
): string => {
  const { change, label } = input;
  const lines =
    change.fields.length > 0 ? changeSection(label, change, body) : [];
  const files = change.attachments;
  if (files.added.length > 0 || files.removed.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(...attachmentChangeSection(label, files));
  }
  if (input.feedback !== null) {
    lines.push(
      '',
      '## Review feedback',
      '',
      input.feedback.trim(),
      '',
      `Address it on the same branch, commit, then call ${FINISH_CARD_TOOL}.`,
    );
  } else {
    lines.push(
      '',
      `Continue the work with the card as it is now, on the same branch; commit, then call ${FINISH_CARD_TOOL}.`,
    );
  }
  return lines.join('\n');
};

/**
 * #273 D3: the prompt of a round that resumes the card's session (a Run
 * after a stop, a failure or an end, or feedback). Without a change it is
 * what it always was; with one, a `## Card changed` section carries the full
 * current text (D2), and (#309 D10) an `## Attachments changed` section the
 * attachments added and removed. The prompt always fits `card.run` (D4): the
 * title, the feedback and the attachments are never cut, the body is cut at
 * a code point.
 */
export const cardNextRoundPrompt = (input: CardNextRoundInput): string => {
  const { change, feedback } = input;
  if (change === null) {
    return feedback === null
      ? CARD_CONTINUE_PROMPT
      : cardFeedbackPrompt(feedback);
  }
  const withChange = { ...input, change };
  if (!change.fields.includes('body'))
    return assembleNextRound(withChange, null);
  const body = change.now.body.trim();
  const prompt = assembleNextRound(withChange, body);
  const over = utf8Bytes(prompt) - CARD_RUN_PROMPT_MAX_BYTES;
  if (over <= 0) return prompt;
  return assembleNextRound(
    withChange,
    cutToBytes(body, utf8Bytes(body) - over, CARD_BODY_CUT_SUFFIX),
  );
};
