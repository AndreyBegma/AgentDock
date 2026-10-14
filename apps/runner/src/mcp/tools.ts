import {
  ACTION_REQUEST_SUMMARY_MAX,
  actionRequestKindSchema,
} from '@agentdock/shared';
import {
  LOCAL_CARD_SUMMARY_MAX,
  LOCAL_NOTE_MAX,
  type LocalMethodName,
} from '@agentdock/shared/protocol';
import { z } from 'zod';

/**
 * One `agentdock` MCP tool (spec 201 D20): a name Claude shows as
 * `mcp__plugin_agentdock_agentdock__<name>`, the local method it calls (D7)
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
      'Create a GitHub issue in this project. With queue: true it is also labelled for the orchestrator to pick up.',
    method: 'issue.create',
    input: {
      title: z.string().min(1).max(256),
      body: z.string().max(20_000),
      labels: z.array(z.string().min(1).max(50)).max(10).optional(),
      queue: z
        .boolean()
        .describe('True to queue the issue for the orchestrator.'),
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
      'Hand this work off: records an issue with the state of a branch so another agent or a person can continue it.',
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
      kind: actionRequestKindSchema,
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
      'Only for the worker of an AgentDock board card: report the card done, with a summary of what changed. AgentDock then opens or updates the pull request. Any other session is refused (not_a_card_session).',
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
    name: 'away',
    description:
      'Turn away mode on or off for this runner. While it is on, permission prompts are sent to a person to approve remotely.',
    method: 'away.set',
    input: { on: z.boolean() },
  },
] as const satisfies readonly McpToolDefinition[];
