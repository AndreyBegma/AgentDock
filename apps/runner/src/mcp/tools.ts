import {
  ACTION_REQUEST_SUMMARY_MAX,
  CARD_EFFORTS,
  CARD_ESCALATION_NOTE_MAX,
  CARD_ESCALATION_REASONS,
  CARD_RECOMMENDABLE_MODELS,
  ESCALATE_CARD_TOOL,
  REVIEW_FINDING_BODY_MAX,
  REVIEW_FINDING_SEVERITIES,
  REVIEW_FINDING_TITLE_MAX,
  REVIEW_FINDINGS_MAX,
  REVIEW_REPORT_TOOL,
  REVIEW_SUMMARY_MAX,
  requestableActionRequestKindSchema,
} from '@nautelle/shared';
import {
  BOARD_WAIT_TIMEOUT_MAX_SEC,
  LOCAL_BOARD_COLUMNS,
  LOCAL_BOARD_WAIT_CARDS_MAX,
  LOCAL_BOARD_WAIT_CURSOR_MAX,
  LOCAL_CARD_BODY_MAX,
  LOCAL_CARD_FEEDBACK_MAX,
  LOCAL_CARD_KINDS,
  LOCAL_CARD_SUMMARY_MAX,
  LOCAL_CARD_TITLE_MAX,
  LOCAL_NOTE_MAX,
  type LocalMethodName,
} from '@nautelle/shared/protocol';
import { z } from 'zod';

/**
 * One `nautelle` MCP tool (spec 201 D20): a name Claude shows as
 * `mcp__plugin_nautelle_nautelle__<name>`, the local method it calls (D7)
 * and the input the model fills in. `method` and `args` are checked by the
 * daemon's and the server's own schemas again; the shape here only gives the
 * model a usable description.
 */
export interface McpToolDefinition {
  name: string;
  description: string;
  method: LocalMethodName;
  input: z.ZodRawShape;
  /**
   * C-144 (L-14): the result carries GitHub-authored text (issue and pull
   * request titles), so the server fences it as untrusted data.
   */
  untrusted?: true;
}

const limit = z
  .number()
  .int()
  .min(1)
  .max(50)
  .optional()
  .describe('How many items, 1–50 (default 10).');

const cardNumber = z
  .number()
  .int()
  .positive()
  .describe('The card’s per-project number: C-42 is 42.');

/** #845 D9: said by every control tool. */
const MANUAL_ONLY =
  'Only for a person’s own terminal session and an operator or better; a card session is refused not_a_manual_session, a viewer forbidden.';

export const MCP_TOOLS = [
  {
    name: 'status',
    description:
      'The fleet of this project: whether the orchestrator is present and its state, and every slot with its issue, state and last activity.',
    method: 'fleet.status',
    input: {},
  },
  {
    name: 'queue',
    description:
      'Issues in this project’s queue: number, title, labels, whether each is ready (cs:ready) and whether it is already in flight.',
    method: 'queue.list',
    untrusted: true,
    input: { limit },
  },
  {
    name: 'budget',
    description:
      'The remaining budget of this project and of the local user, per scope and period.',
    method: 'budget.remaining',
    input: {},
  },
  {
    name: 'approvals',
    description:
      'Pull requests waiting for approval and the action requests still pending a person’s decision.',
    method: 'approvals.list',
    untrusted: true,
    input: {},
  },
  {
    name: 'activity',
    description: 'The most recent activity events of this project.',
    method: 'activity.recent',
    untrusted: true,
    input: { limit },
  },
  {
    name: 'sessions',
    description: 'The most recent agent sessions of this project.',
    method: 'sessions.recent',
    untrusted: true,
    input: { limit },
  },
  {
    name: 'create_issue',
    description:
      'Create a GitHub issue in this project. With queue: true it is not queued yet: Nautelle asks a person to approve queuing it for the orchestrator, and the result carries that request (actionRequestId, poll it with action_status).',
    method: 'issue.create',
    input: {
      title: z.string().min(1).max(256),
      body: z.string().max(20_000),
      labels: z.array(z.string().min(1).max(50)).max(10).optional(),
      queue: z
        .boolean()
        .describe(
          'True to ask a person to queue the issue for the orchestrator.',
        ),
    },
  },
  {
    name: 'note',
    description: 'Post a short note to this project’s activity feed.',
    method: 'activity.note',
    input: { text: z.string().min(1).max(LOCAL_NOTE_MAX) },
  },
  {
    name: 'handoff',
    description:
      'Hand this work off: records an issue with the state of a branch so another agent or a person can continue it. The fleet takes it only once a person approves it; the result carries that request (actionRequestId, poll it with action_status).',
    method: 'handoff.create',
    input: {
      title: z.string().min(1).max(256),
      body: z.string().max(18_000),
      branch: z.string().min(1).max(255),
    },
  },
  {
    name: 'request_action',
    description:
      'Ask a person to approve something you may not do yourself: starting or stopping the orchestrator, approving a pull request, or accepting a Finished board card into Completed (card_accept). Returns a request; poll it with action_status.',
    method: 'action.request',
    input: {
      kind: requestableActionRequestKindSchema,
      args: z
        .record(z.string(), z.unknown())
        .describe(
          'orchestrator_start: {mode?: "start"|"next"}; orchestrator_stop: {}; pr_approve: {pr: number}; tool_use: {toolName: string}; card_accept: {card: number, merge?: boolean} — merge also merges the card’s pull request while it is open.',
        ),
      summary: z.string().min(1).max(ACTION_REQUEST_SUMMARY_MAX),
    },
  },
  {
    name: 'action_status',
    description: 'The state of an action request made with request_action.',
    method: 'action.status',
    input: { id: z.string().min(1).max(64) },
  },
  {
    name: 'finish_card',
    description:
      'For the worker of a Nautelle board card: report the card done, with a summary of what changed. Nautelle then opens or updates the pull request. For a manual session that took a card (take_card): you pushed and opened the pull request yourself, so pass pullRequestUrl; the card moves to Finished with it recorded and the answer carries the next queued card, if any. Any other session is refused (not_a_card_session).',
    method: 'card.finish',
    input: {
      summary: z
        .string()
        .min(1)
        .max(LOCAL_CARD_SUMMARY_MAX)
        .describe('What was done on the card, for the pull request body.'),
      pullRequestUrl: z
        .url({ protocol: /^https$/ })
        .optional()
        .describe(
          'Only for a card you took with take_card: the https GitHub URL of the pull request you opened. A card worker’s finish ignores it.',
        ),
    },
  },
  {
    name: 'board_list',
    description:
      'The Board of this project: its settings (merge policy, maxRunning, active rounds) and the cards in board order, with number, title, kind, column, running round, pull request state and CI state. Optional column filter. Read tool: any session of the project may call it.',
    method: 'board.list',
    untrusted: true,
    input: {
      column: z
        .enum(LOCAL_BOARD_COLUMNS)
        .optional()
        .describe('Only the cards of this column.'),
    },
  },
  {
    name: 'board_card',
    description:
      'One board card in full: body, dependencies, a summary of its rounds, pull request, CI and the question its session is waiting on, if any. Read tool: any session of the project may call it.',
    method: 'board.card',
    untrusted: true,
    input: { card: cardNumber },
  },
  {
    name: 'board_wait',
    description: `Wait for the board to change. Returns the events after cursor — a card changed column, a round ended, CI changed, a pull request merged, a card session waits on a question (with its text and options) — on the first event, or empty at timeoutSec (up to ${BOARD_WAIT_TIMEOUT_MAX_SEC}; reaching it is not an error), always with the next cursor. Without a cursor it starts from now. Pass the returned cursor to the next call; it survives a context compaction. Read tool: any session of the project may call it.`,
    method: 'board.wait',
    untrusted: true,
    input: {
      cursor: z
        .string()
        .min(1)
        .max(LOCAL_BOARD_WAIT_CURSOR_MAX)
        .optional()
        .describe('The cursor of the previous board_wait; omit to start now.'),
      cards: z
        .array(cardNumber)
        .min(1)
        .max(LOCAL_BOARD_WAIT_CARDS_MAX)
        .optional()
        .describe(
          'Only these cards; default every card outside Inbox and Completed.',
        ),
      timeoutSec: z
        .number()
        .int()
        .min(0)
        .max(BOARD_WAIT_TIMEOUT_MAX_SEC)
        .optional()
        .describe(
          `Seconds to wait in total, 0–${BOARD_WAIT_TIMEOUT_MAX_SEC} (default ${BOARD_WAIT_TIMEOUT_MAX_SEC}).`,
        ),
    },
  },
  {
    name: 'card_create',
    description: `Create a board card. On the person’s explicit request it goes to the top of To Do; with candidate: true (a card you propose on your own) it goes to the Inbox. ${MANUAL_ONLY}`,
    method: 'card.create',
    input: {
      title: z
        .string()
        .trim()
        .min(1)
        .max(LOCAL_CARD_TITLE_MAX)
        .describe('A short title, like an issue title.'),
      body: z
        .string()
        .max(LOCAL_CARD_BODY_MAX)
        .optional()
        .describe('What and why; markdown.'),
      kind: z.enum(LOCAL_CARD_KINDS).optional(),
      candidate: z
        .boolean()
        .optional()
        .describe('True to put the card in the Inbox as a proposal.'),
    },
  },
  {
    name: 'card_run',
    description: `Start a Board Run of a card: a dedicated worktree and card session. The Board’s refusals come back unchanged — dependency_open, design_not_approved, stack_design_not_approved, budget_exceeded, max_running — obey them, never work around them. ${MANUAL_ONLY}`,
    method: 'card.run',
    input: {
      card: cardNumber,
      model: z.enum(CARD_RECOMMENDABLE_MODELS).optional(),
      effort: z.enum(CARD_EFFORTS).optional(),
    },
  },
  {
    name: 'card_move',
    description: `Move a card to a column, at index (0 is the top; default the bottom). Moving to completed is refused completed_needs_person: only a person accepts a card — use request_action with card_accept. Other board refusals (move_refused) come back with the Board’s message. ${MANUAL_ONLY}`,
    method: 'card.move',
    input: {
      card: cardNumber,
      column: z.enum(LOCAL_BOARD_COLUMNS),
      index: z.number().int().min(0).optional(),
    },
  },
  {
    name: 'card_feedback',
    description: `Send feedback on a Finished card (red CI, review findings): starts a feedback round of its session. ${MANUAL_ONLY}`,
    method: 'card.feedback',
    input: {
      card: cardNumber,
      text: z.string().trim().min(1).max(LOCAL_CARD_FEEDBACK_MAX),
    },
  },
  {
    name: 'card_message',
    description: `Message a card’s running session: kind text sends text; kind option answers its question selector by option index, kind other by free text — both need the questionKey from board_wait or board_card. The outcome says what became of it (sent, answered, no_session, question, question_changed, not_at_input, no_option). ${MANUAL_ONLY}`,
    method: 'card.message',
    input: {
      card: cardNumber,
      kind: z.enum(['text', 'option', 'other']),
      text: z.string().optional().describe('For kind text and other.'),
      questionKey: z
        .string()
        .optional()
        .describe('For kind option and other: the key of the question.'),
      index: z
        .number()
        .int()
        .min(1)
        .max(99)
        .optional()
        .describe('For kind option: the option’s number on screen, 1-based.'),
    },
  },
  {
    name: 'card_stop',
    description: `Stop a card’s running round. ${MANUAL_ONLY}`,
    method: 'card.stop',
    input: { card: cardNumber },
  },
  {
    name: 'take_card',
    description: `Take a card to work on yourself, in your current checkout: a To Do card (or an In progress one whose taking session ended) moves to In progress, bound to this session. You push and open the pull request yourself, then call finish_card with pullRequestUrl. If you already hold a card, this one is queued for you and the answer says so (state: queued). card_taken: another live session holds it or a Board Run is active. ${MANUAL_ONLY}`,
    method: 'card.take',
    untrusted: true,
    input: { card: cardNumber },
  },
  {
    name: 'release_card',
    description: `Give a card you took or queued back: it returns to To Do and its binding and queue marker are cleared; releasing the held card takes the next queued one. not_taken: this session neither holds nor queued it. ${MANUAL_ONLY}`,
    method: 'card.release',
    untrusted: true,
    input: { card: cardNumber },
  },
  {
    name: 'track_card',
    description:
      'Track the work the person just asked you to do as a card on the Nautelle Board (In progress, linked to this session). Call it once per piece of work; a second call from the same session updates that card and never creates another. Only for a person’s own terminal session; any other session is refused (not_a_manual_session).',
    method: 'card.track',
    input: {
      title: z
        .string()
        .trim()
        .min(1)
        .max(LOCAL_CARD_TITLE_MAX)
        .describe('A short title of the work, like an issue title.'),
      body: z
        .string()
        .max(LOCAL_CARD_BODY_MAX)
        .optional()
        .describe('What is being done and why; markdown.'),
      kind: z
        .enum(LOCAL_CARD_KINDS)
        .optional()
        .describe('feature or bug, only when it is obvious.'),
    },
  },
  {
    name: 'away',
    description:
      'Turn away mode on or off for this runner. While it is on, permission prompts are sent to a person to approve remotely.',
    method: 'away.set',
    input: { on: z.boolean() },
  },
] as const satisfies readonly McpToolDefinition[];

/**
 * #750 D8: set to `1` in the env of a card round launched with `escalate`
 * (a non-Opus round in the B arm of `model-by-type`); the MCP server offers
 * `escalate_card` only then.
 */
export const CARD_ESCALATE_ENV = 'NAUTELLE_CARD_ESCALATE';

/**
 * #750 D8: the card worker asks for Opus. Not in `MCP_TOOLS`: it is listed
 * only on a round launched with `escalate`, and the runner stops the session
 * once it answers.
 */
export const ESCALATE_CARD_MCP_TOOL = {
  name: ESCALATE_CARD_TOOL,
  description:
    'Only for the worker of a Nautelle board card: stop and hand the card to a stronger model (Opus). Call it instead of making a decision the card did not settle, or when you cannot finish the card at this model. It ends this round; Nautelle starts the card again on Opus, which gets your note. Any other session is refused (not_a_card_session).',
  method: 'card.escalate',
  input: {
    reason: z
      .enum(CARD_ESCALATION_REASONS)
      .describe(
        'misclassified: the card needs decisions it did not show. gave_up: you cannot finish it at this model.',
      ),
    note: z
      .string()
      .trim()
      .min(1)
      .max(CARD_ESCALATION_NOTE_MAX)
      .describe(
        'What you found and why you stop: the decision that is open, what you tried, what the next worker needs.',
      ),
  },
} as const satisfies McpToolDefinition;

/**
 * #884: set to `1` in the env of a review session (`card.review`); the MCP
 * server then offers `report_review` and the read tools only.
 */
export const CARD_REVIEW_ENV = 'NAUTELLE_CARD_REVIEW';

/**
 * #884: the tools a review session keeps besides `report_review` — reading
 * the fleet and the Board. A review session reviews and reports; it never
 * finishes, takes, tracks, moves or creates a card, files an issue, hands
 * off, asks for an action or escalates.
 */
export const REVIEW_SESSION_TOOLS: readonly string[] = [
  'status',
  'queue',
  'budget',
  'approvals',
  'activity',
  'sessions',
  'board_list',
  'board_card',
];

const reviewFinding = z.object({
  severity: z
    .enum(REVIEW_FINDING_SEVERITIES)
    .describe(
      'blocking: must be fixed before the card is Finished (a bug, a broken contract, a missing test the rules require, a security hole). nit: a suggestion that never holds the card back.',
    ),
  file: z
    .string()
    .trim()
    .min(1)
    .max(1_000)
    .optional()
    .describe(
      'The file, relative to the repository root (no leading slash, no ..). Omit for a finding about the change as a whole.',
    ),
  line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('1-based line in file, on the head side of the diff.'),
  title: z
    .string()
    .trim()
    .min(1)
    .max(REVIEW_FINDING_TITLE_MAX)
    .describe('One line: what is wrong.'),
  body: z
    .string()
    .trim()
    .max(REVIEW_FINDING_BODY_MAX)
    .describe('Why it matters and what to change; markdown.'),
});

/**
 * #884 (ADR-0084 §4): a review session reports its findings, the way a card
 * worker calls `finish_card`. Not in `MCP_TOOLS`: it is listed only in a
 * review session (`CARD_REVIEW_ENV`).
 */
export const REPORT_REVIEW_MCP_TOOL = {
  name: REVIEW_REPORT_TOOL,
  description:
    'Only for a Nautelle review session: report the review of this pull request. Call it once, at the end, with every finding — an empty list when there is nothing to report. blocking findings start a fix round; nit findings never do. Review only: do not edit files, commit or push. Any other session is refused (not_a_review_session).',
  method: 'card.reviewReport',
  input: {
    findings: z
      .array(reviewFinding)
      .max(REVIEW_FINDINGS_MAX)
      .describe(`Every finding, at most ${REVIEW_FINDINGS_MAX}.`),
    summary: z
      .string()
      .trim()
      .max(REVIEW_SUMMARY_MAX)
      .optional()
      .describe('A short overall verdict; markdown.'),
  },
} as const satisfies McpToolDefinition;
