import type { CardAttachmentBrief } from '../attachments/contracts';
import { ATTACHMENTS_WORKTREE_DIR } from '../attachments/limits';
import { attachmentWorktreePath } from '../attachments/names';
import { attachmentKindLabel } from '../attachments/types';
import { HANDOFF_NOTE_MAX_TOKENS, HANDOFF_SECTIONS } from '../handoff/note';
import { CARD_RUN_PROMPT_MAX_BYTES } from '../protocol/commands/cards';
import { cardLabel } from './naming';
import type { CardCiCheck } from './shipping';
import type { BoardCardKind } from './types';

/**
 * D17: the card worker's prompt. Fixed, versioned code — not cs-worker, not
 * editable (ADR-0024 scopes ADR-0005). A change to the text bumps
 * `CARD_WORKER_PROMPT_VERSION`, which the API records on each round's run.
 * Version 4 (#309 D10): the `## Attachments` sections. Version 5 (#359 D3):
 * the pull request description file. Version 6 (#359 D1, D6): AgentDock
 * pushes during the round; the `ci_fix` round prompt. Version 7 (#389): the
 * card's own test database and port, and no `pgrep -f` waits. Version 8
 * (#441): the `## Design` section lists every frame of the approved variant.
 * Version 9 (#445 D7, D10, D14): the stable sections first and the card
 * last; the working and audience registers; Read/Grep guidance; with Token
 * saver, the scout and the `AGENTDOCK_RAW=1` bypass. Version 10 (#447 D7):
 * no Claude attribution trailer on a commit. Version 11 (#449 D2, D5, D7):
 * with Token saver (Context handoff rides on it), the `## Handoff note`
 * section.
 */
export const CARD_WORKER_PROMPT_VERSION = 11;

/** #389: the env the runner sets in the card's session — its short id. */
export const CARD_ENV_ID = 'AGENTDOCK_CARD';

/** #389: the env the runner sets in the card's session — a port of its own. */
export const CARD_ENV_PORT = 'AGENTDOCK_CARD_PORT';

/**
 * #389: two cards' e2e runs wiped one shared test database, and a worker
 * waited 7.5 h on a `pgrep -f` loop that matched itself. Every card worktree
 * keeps to a database and a port of its own, so no card waits on another.
 */
const LOCAL_ENVIRONMENT_LINES = [
  `- This session has \`${CARD_ENV_ID}\` (this card's id) and \`${CARD_ENV_PORT}\` set. Tests and servers keep to a database and a port of their own: name a test database after \`$${CARD_ENV_ID}\` (a project's test setup may already do it — check before you create one), and start a server on \`$${CARD_ENV_PORT}\`. Never use, reset or wait for a database or port another worktree may use.`,
  "- Never wait for another process with `pgrep -f <pattern>`: the pattern is on your own command line, so it always matches and the wait never ends. Use a lock file, or a pattern that cannot match itself (`pgrep -f '[j]est'`). Never wait on another worktree's test run.",
];

/**
 * #447 D7: the runner holds the push of a commit that carries a Claude
 * attribution trailer (`hasClaudeTrailer`), so the worker never writes one.
 */
const COMMIT_TRAILER_LINE =
  '- Never add a Claude attribution trailer or footer to a commit message — no `Co-Authored-By: Claude …`, no `Claude-Session: …`, no "Generated with Claude Code". AgentDock does not push a commit that carries one; if it tells you which commits do, rewrite their messages without it (do not push).';

/** The MCP tool the worker calls when done (D6). */
export const FINISH_CARD_TOOL = 'finish_card';

/**
 * #359 D3: the PR description the worker writes, worktree-relative. Under
 * `.agentdock/`, which the runner git-excludes; `card.collect` makes it the
 * PR body.
 */
export const CARD_PR_DESCRIPTION_FILE = '.agentdock/pull-request.md';

/** #449 D4: the card's handoff note, worktree-relative; git-excluded like the PR description. */
export const HANDOFF_NOTE_PATH = '.agentdock/handoff.md';

/** #243 D7: the addressed comment bodies the `## Design` section carries, in UTF-8 bytes. */
export const CARD_DESIGN_COMMENTS_MAX_BYTES = 4 * 1024;

/** #441: one frame of the approved design, as the worker opens it. */
export interface CardWorkerDesignFrame {
  name: string;
  /** Repository-relative, from `cardDesignPath`. */
  path: string;
}

/** #243 D7: the card's approved design, committed by the runner before round 1. */
export interface CardWorkerDesign {
  /** #441: every frame of the approved variant, in order; at least one. */
  frames: CardWorkerDesignFrame[];
  /** The approved revision's rationale. */
  rationale: string;
  /** Bodies of the comments a revision addressed, oldest first. */
  comments: string[];
}

/**
 * #480 (ADR-0043): the stack the card is part of. Its approved design shows
 * the whole result and is committed on the card's branch as reference; the
 * card's own design, if any, stays its own.
 */
export interface CardWorkerStack {
  /** `S-<number>`. */
  label: string;
  title: string;
  /** 0-based. */
  stage: number;
  stageTitle: string;
  stageCount: number;
  /** The approved stack design's frames, repository-relative; null without one. */
  design: { frames: CardWorkerDesignFrame[]; rationale: string } | null;
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
  /** #480: the card's stack; absent or `null` when it is in none. */
  stack?: CardWorkerStack | null;
  /**
   * #309 D10: the card's and its rounds' attachments, in upload order — the
   * same list `card.run` carries. Absent is none.
   */
  attachments?: readonly CardAttachmentBrief[];
  /**
   * #445: the round is launched with Token saver on (`card.run` carries
   * `tokenSaver.enabled`). The prompt then names the scout and the
   * `AGENTDOCK_RAW=1` bypass, which exist only then. Absent is off.
   */
  tokenSaver?: boolean;
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

/**
 * #243 D7, #441: what the approved mockup binds — one file, or every frame
 * with its name — and the decisions behind it.
 */
const designSection = (
  frames: readonly CardWorkerDesignFrame[],
  rationale: string,
  comments: string[],
  commentBudget: number,
): string[] => {
  const lines = ['## Design', ''];
  if (frames.length === 1) {
    lines.push(
      `The approved mockup is ${frames[0].path} (already committed on this branch — open it first).`,
      "It binds the layout, the states and the copy. It is not code to copy: build it with the project's real components.",
    );
  } else {
    lines.push(
      `The approved design has ${frames.length} frames, each a separate mockup (already committed on this branch — open them first):`,
      '',
      ...frames.map((f) => `- ${f.path} — ${oneLine(f.name)}`),
      '',
      "They bind the layout, the states and the copy. They are not code to copy: build them with the project's real components.",
    );
  }
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
 * #480: the card's place in its stack and — with one — the stack's approved
 * design, the whole result this card builds a part of.
 */
const stackSection = (stack: CardWorkerStack, rationale: string): string[] => {
  const stage = `stage ${stack.stage + 1} of ${stack.stageCount}${stack.stageTitle.trim() ? ` (${oneLine(stack.stageTitle)})` : ''}`;
  const lines = [
    '## Stack',
    '',
    `This card is part of stack ${stack.label} "${oneLine(stack.title)}", ${stage}. Other cards of the stack build the rest: build only what this card asks for, consistent with the whole.`,
  ];
  const frames = stack.design?.frames ?? [];
  if (frames.length > 0) {
    lines.push(
      '',
      frames.length === 1
        ? `The stack's approved design shows the whole result: ${frames[0].path} (already committed on this branch, as reference).`
        : `The stack's approved design shows the whole result, in ${frames.length} frames (already committed on this branch, as reference):`,
      ...(frames.length === 1
        ? []
        : ['', ...frames.map((f) => `- ${f.path} — ${oneLine(f.name)}`), '']),
      "It is reference for this card's part, not code to copy. Where this card has its own design (## Design), that one binds this card.",
    );
    if (rationale) lines.push('', `Why the stack design: ${rationale}`);
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
  const stack = card.stack ?? null;
  const attachments = card.attachments ?? [];
  let rationale = design?.rationale.trim() ?? '';
  let stackRationale = stack?.design?.rationale.trim() ?? '';
  let commentBudget = design ? CARD_DESIGN_COMMENTS_MAX_BYTES : 0;
  let withNames = attachments.length > 0;
  let body = card.body.trim();
  let bodyCut = false;
  for (;;) {
    const prompt = assemblePrompt(
      card,
      body,
      design
        ? designSection(
            design.frames,
            rationale,
            design.comments,
            commentBudget,
          )
        : null,
      attachments.length > 0
        ? attachmentsSection(attachments, withNames)
        : null,
      stack ? stackSection(stack, stackRationale) : null,
    );
    const over = utf8Bytes(prompt) - CARD_RUN_PROMPT_MAX_BYTES;
    if (over <= 0) return prompt;
    if (stackRationale) {
      stackRationale = cutToBytes(
        stackRationale,
        utf8Bytes(stackRationale) - over,
      );
    } else if (commentBudget > 0) {
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

/**
 * #441: the design's link in the PR description — its one file, or the
 * folder that holds every frame.
 */
const designLink = (card: CardWorkerPromptInput): string => {
  const frames = card.design?.frames ?? [];
  const repo = 'https://github.com/<owner>/<repo>';
  if (frames.length === 1)
    return `${repo}/blob/${card.branch}/${frames[0].path}`;
  const first = frames[0]?.path ?? '';
  return `${repo}/tree/${card.branch}/${first.slice(0, first.lastIndexOf('/'))}`;
};

/**
 * #359 D3: what the worker writes to `CARD_PR_DESCRIPTION_FILE` before it
 * finishes — the spec (and design) link, `Closes #n` with an issue, what
 * changed, and the acceptance checklist.
 */
const pullRequestSection = (card: CardWorkerPromptInput): string[] => {
  const blob = `https://github.com/<owner>/<repo>/blob/${card.branch}/`;
  const lines = [
    '## Pull request description',
    '',
    `Before you finish, write the pull request's description to \`${CARD_PR_DESCRIPTION_FILE}\` in this worktree. It is git-excluded — do not commit it; AgentDock makes it the pull request's body. Keep it current in later rounds. It holds, in this order:`,
    '',
  ];
  if (card.specPath !== null) {
    const design = card.design ? ` · Design: ${designLink(card)}` : '';
    lines.push(
      `- \`Spec: ${blob}${card.specPath}${design}\` — <owner>/<repo> from \`git remote get-url origin\`;`,
    );
  }
  if (card.issueNumber !== null) {
    lines.push(`- \`Closes #${card.issueNumber}\`;`);
  }
  lines.push(
    '- `## What changed and why` — short, by module;',
    '- `## Acceptance criteria` — the checklist from the spec (or the card): `[x]` with how you checked it, `[ ]` with why not.',
  );
  return lines;
};

/**
 * #445 D7: two registers. What only the worker reads is terse; what a person
 * reads is complete.
 */
const REGISTER_LINES = [
  '## How to write',
  '',
  '- Working register — everything only you read while you work: do not narrate what you are about to do, do not restate the plan, keep status lines short. Let the tool calls and the code speak.',
  `- Audience register — everything a person reads: a question to the person, the pull request description, the \`${FINISH_CARD_TOOL}\` summary, a spec, a design file. Write it in full sentences, with every required section, and leave nothing out. Never shorten these to save tokens.`,
];

/** #445 D14: built-in Read, Grep and Glob are not filtered — the worker reads only what it needs. */
const READING_LINES = [
  '## Reading the codebase',
  '',
  '- Find where to look with Grep and Glob first. Read a large file with `offset` and `limit` — the part you need, not the whole file.',
];

/** #445 D4c, D9: what exists only when the runner launched the card with Token saver on. */
const TOKEN_SAVER_LINES = [
  '- For a broad search or to read many files for one question, use the `scout` subagent: it is fast and cheap, and reports file paths and lines. Make decisions and write code yourself, never through the scout.',
  '- Long command output is compressed: every error, failure and warning line is kept, and a last line names the file with the full output. Read that file when you need more, or run the command as `AGENTDOCK_RAW=1 <command>` to see it unfiltered.',
];

/**
 * #449 D2, D5, D7: the note the next round or session starts from. Exists
 * only with Token saver on, like the scout — Context handoff is on with it.
 */
const HANDOFF_LINES = [
  '## Handoff note',
  '',
  `Keep a short handoff note in \`${HANDOFF_NOTE_PATH}\` (git-excluded — do not commit it): what the next session needs to continue without re-learning the task. A later round may start a fresh session from it instead of this one.`,
  `- Update it after you settle the plan, after a decision, after each commit, and before you stop or call \`${FINISH_CARD_TOOL}\`.`,
  `- Use exactly these \`## \` sections, in this order, each with short bullet points or "none": ${HANDOFF_SECTIONS.join(', ')}. "Next" is an ordered list; "Dead ends" says what you tried and why it did not work; "How to verify" lists commands. At most about ${HANDOFF_NOTE_MAX_TOKENS} tokens.`,
  '- A line ending with `<!-- person -->` is an instruction from a person: keep it word for word, mark included, and follow it. Never add that mark yourself.',
  '- If AgentDock answers that the note was not accepted, fix what it names.',
];

/**
 * #445 D10: the stable sections — the same for every card — come first, so
 * the prompt cache hits; the card's own sections come last.
 */
const assemblePrompt = (
  card: CardWorkerPromptInput,
  body: string,
  design: string[] | null,
  attachments: string[] | null,
  stack: string[] | null = null,
): string => {
  const label = cardLabel(card.number);
  const lines = [
    'You are the dedicated worker for an AgentDock board card. How to work comes first; the card itself is at the end of this prompt.',
    '',
    '## How to work',
    '',
    '- Work only in this worktree and on this branch. Do not switch branches or touch other worktrees.',
    "- Follow the repository's CLAUDE.md / AGENTS.md.",
    '- Commit your work as you go, with clear messages.',
    COMMIT_TRAILER_LINE,
    '- Run the tests and checks the repository defines before you finish.',
    ...LOCAL_ENVIRONMENT_LINES,
    '- Do not push and do not open a pull request: AgentDock pushes your commits as you make them and keeps a draft pull request open for this branch.',
    '- If something is unclear, ask in this session and wait for the person.',
    '',
    ...REGISTER_LINES,
    '',
    ...READING_LINES,
    ...(card.tokenSaver ? TOKEN_SAVER_LINES : []),
    '',
    ...(card.tokenSaver ? [...HANDOFF_LINES, ''] : []),
    '## When you are done',
    '',
    `Write the pull request description the last section of this prompt asks for. Then call the \`${FINISH_CARD_TOOL}\` tool with a summary of what you changed and how you checked it, in at least two full sentences. If it answers with what is missing, write that and call it again.`,
    `If the \`${FINISH_CARD_TOOL}\` tool is not available, reply with the summary followed by the single word DONE, and stop.`,
    '',
    `## Card ${label}: ${card.title}`,
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
  if (stack !== null) lines.push(...stack, '');
  if (attachments !== null) lines.push(...attachments, '');
  lines.push(...pullRequestSection(card));
  return lines.join('\n');
};

/** D9: the prompt of a feedback round, resuming the same session. */
export const cardFeedbackPrompt = (feedback: string): string =>
  `Review feedback: ${feedback.trim()}\n\nAddress it on the same branch, commit, then call ${FINISH_CARD_TOOL}.`;

/** A retry after a failed, ended or cancelled round resumes with this. */
export const CARD_CONTINUE_PROMPT = 'continue';

/** #359 D6: failed checks a `ci_fix` prompt names one by one; the rest are counted. */
export const CARD_CI_FIX_CHECKS_LISTED_MAX = 10;

/** #359 D6: the project's checks as the prompt names them, in UTF-8 bytes. */
export const CARD_CI_FIX_CHECKS_TEXT_MAX_BYTES = 4 * 1024;

/**
 * #359 D6: why AgentDock started a `ci_fix` round.
 * - `red` — a check failed on `headSha`; `checks` is the project's own
 *   check commands (`orchestrator.checks`), `null` when it has none.
 * - `conflict` — the PR conflicts with `base`.
 */
export type CardCiFixInput =
  | {
      reason: 'red';
      headSha: string;
      failed: readonly CardCiCheck[];
      checks: string | null;
    }
  | { reason: 'conflict'; base: string };

const failedCheckLine = (check: CardCiCheck): string =>
  check.link === null
    ? `- ${oneLine(check.name)}`
    : `- ${oneLine(check.name)} — ${check.link}`;

/**
 * #359 D6: the prompt of a `ci_fix` round, resuming the card's session. A red
 * check: "CI failed on <head>: <check> — <link> (and the rest). Reproduce it
 * with the project's checks, fix it, commit, and call finish_card." A
 * conflict: merge `origin/<base>`, resolve, commit. CI logs are not quoted —
 * the worker reproduces the failure itself (spec, out of scope).
 */
export const cardCiFixPrompt = (input: CardCiFixInput): string => {
  if (input.reason === 'conflict') {
    return [
      `The pull request of this branch conflicts with ${input.base}.`,
      '',
      `Merge origin/${input.base} into this branch (git fetch origin ${input.base}, then git merge origin/${input.base}), resolve the conflicts, run the project's checks, commit the merge, and call ${FINISH_CARD_TOOL}.`,
      'Do not rebase and do not push: AgentDock pushes your commits.',
    ].join('\n');
  }
  const listed = input.failed.slice(0, CARD_CI_FIX_CHECKS_LISTED_MAX);
  const rest = input.failed.length - listed.length;
  const checks = input.checks?.trim()
    ? cutToBytes(input.checks.trim(), CARD_CI_FIX_CHECKS_TEXT_MAX_BYTES)
    : null;
  const lines = [
    `CI failed on ${input.headSha.slice(0, 12)}:`,
    '',
    ...(listed.length > 0
      ? listed.map(failedCheckLine)
      : ['- (the failed checks were not named)']),
  ];
  if (rest > 0) lines.push(`- (and ${rest} more)`);
  lines.push(
    '',
    checks !== null
      ? `Reproduce the failure with the project's checks:\n\n${checks}\n`
      : "Reproduce the failure with the checks the repository's CLAUDE.md / AGENTS.md defines.",
    `Fix it, commit, and call ${FINISH_CARD_TOOL}. Do not push: AgentDock pushes your commits.`,
  );
  return lines.join('\n');
};

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
