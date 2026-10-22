import {
  ACTION_REQUEST_SUMMARY_MAX,
  CARD_ESCALATION_NOTE_MAX,
  CARD_ESCALATION_REASONS,
  ESCALATE_CARD_TOOL,
  requestableActionRequestKindSchema,
} from '@nautelle/shared';
import {
  LOCAL_CARD_BODY_MAX,
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
}

const limit = z
  .number()
  .int()
  .min(1)
  .max(50)
  .optional()
  .describe('How many items, 1–50 (default 10).');

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
    input: {},
  },
  {
    name: 'activity',
    description: 'The most recent activity events of this project.',
    method: 'activity.recent',
    input: { limit },
  },
  {
    name: 'sessions',
    description: 'The most recent agent sessions of this project.',
    method: 'sessions.recent',
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
      'Ask a person to approve something you may not do yourself: starting or stopping the orchestrator, or approving a pull request. Returns a request; poll it with action_status.',
    method: 'action.request',
    input: {
      kind: requestableActionRequestKindSchema,
      args: z
        .record(z.string(), z.unknown())
        .describe(
          'orchestrator_start: {mode?: "start"|"next"}; orchestrator_stop: {}; pr_approve: {pr: number}; tool_use: {toolName: string}.',
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
      'Only for the worker of a Nautelle board card: report the card done, with a summary of what changed. Nautelle then opens or updates the pull request. Any other session is refused (not_a_card_session).',
    method: 'card.finish',
    input: {
      summary: z
        .string()
        .min(1)
        .max(LOCAL_CARD_SUMMARY_MAX)
        .describe('What was done on the card, for the pull request body.'),
    },
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
