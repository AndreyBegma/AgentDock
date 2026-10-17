import { z } from 'zod';
import { headShaSchema } from '../protocol/commands/approvals';

/**
 * Action requests (docs/specs/201-claude-code-integration.md D18): something a
 * Claude Code session asked for that a person approves in the web or in
 * Telegram. `tool_use` only returns the decision to the waiting
 * `PermissionRequest` hook; the other kinds are executed by the API as the
 * approver.
 */

export const actionRequestKindSchema = z.enum([
  'tool_use',
  'orchestrator_start',
  'orchestrator_stop',
  'pr_approve',
]);
export type ActionRequestKind = z.infer<typeof actionRequestKindSchema>;
export const ACTION_REQUEST_KINDS = actionRequestKindSchema.options;

/** `pending → approved | denied | expired`, then `approved → executed | failed`. */
export const actionRequestStatusSchema = z.enum([
  'pending',
  'approved',
  'denied',
  'expired',
  'executed',
  'failed',
]);
export type ActionRequestStatus = z.infer<typeof actionRequestStatusSchema>;

/** Statuses after which nothing changes any more. */
export const ACTION_REQUEST_FINAL_STATUSES: readonly ActionRequestStatus[] = [
  'denied',
  'expired',
  'executed',
  'failed',
];

/** How long a request waits for a decision (D18). */
export const ACTION_REQUEST_TTL_MS: Record<ActionRequestKind, number> = {
  tool_use: 5 * 60_000,
  orchestrator_start: 24 * 60 * 60_000,
  orchestrator_stop: 24 * 60 * 60_000,
  pr_approve: 24 * 60 * 60_000,
};

/** The `PermissionRequest` hook polls `action.status` this often… */
export const ACTION_REQUEST_POLL_MS = 2_000;
/** …for at most this long, inside its 300 s hook timeout (D17). */
export const ACTION_REQUEST_HOOK_WAIT_MS = 280_000;

export const ACTION_REQUEST_SUMMARY_MAX = 500;
export const ACTION_REQUEST_NOTE_MAX = 1_000;
/** The redacted tool input shown on a `tool_use` request (D17). */
export const ACTION_REQUEST_TOOL_INPUT_MAX = 500;

/**
 * `args` per kind. Strict: the API executes the non-`tool_use` kinds, so
 * nothing may ride along. The project is never in `args` — the API resolves
 * it from the runner's correlation (D9).
 */
export const actionRequestArgsSchemas = {
  tool_use: z.strictObject({
    toolName: z.string().min(1).max(200),
    /** Redacted; present only when the project ships content (D17). */
    input: z.string().max(ACTION_REQUEST_TOOL_INPUT_MAX).optional(),
  }),
  orchestrator_start: z.strictObject({
    mode: z.enum(['start', 'next']).default('start'),
  }),
  orchestrator_stop: z.strictObject({}),
  pr_approve: z.strictObject({
    pr: z.number().int().positive(),
  }),
} as const satisfies Record<ActionRequestKind, z.ZodType>;

export type ActionRequestArgs<K extends ActionRequestKind> = z.infer<
  (typeof actionRequestArgsSchemas)[K]
>;

/** The PR title kept on a `pr_approve` request, at most this long. */
export const ACTION_REQUEST_PR_TITLE_MAX = 300;

/**
 * The stored `args` of a `pr_approve` request: what the session asked for
 * plus what `pr.inspect` read when it was created — the head the person is
 * shown and approves. Never taken from the session.
 */
export const prApproveBoundArgsSchema = z.strictObject({
  pr: z.number().int().positive(),
  headSha: headShaSchema,
  title: z.string().max(ACTION_REQUEST_PR_TITLE_MAX),
  url: z.url({ protocol: /^https?$/ }),
});
export type PrApproveBoundArgs = z.infer<typeof prApproveBoundArgsSchema>;

/** The bound PR of a `pr_approve` request; null for another kind or old args. */
export const boundPrOf = (request: {
  kind: ActionRequestKind;
  args: unknown;
}): PrApproveBoundArgs | null => {
  if (request.kind !== 'pr_approve') return null;
  const parsed = prApproveBoundArgsSchema.safeParse(request.args);
  return parsed.success ? parsed.data : null;
};

/** A commit id as people read it: its first 7 characters. */
export const shortHeadSha = (sha: string): string => sha.slice(0, 7);

/** The PR's diff at `headSha` — what the approver reviews. */
export const prDiffUrl = (args: Pick<PrApproveBoundArgs, 'url' | 'headSha'>) =>
  `${args.url.replace(/\/+$/, '')}/files/${args.headSha}`;

/** A request as the API lists it to the web and answers `action.status` with. */
export const actionRequestSummarySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  runnerId: z.string().min(1),
  sessionId: z.string().min(1).nullable(),
  requestedById: z.string().min(1).nullable(),
  kind: actionRequestKindSchema,
  summary: z.string().max(ACTION_REQUEST_SUMMARY_MAX),
  args: z.record(z.string(), z.unknown()),
  status: actionRequestStatusSchema,
  decidedById: z.string().min(1).nullable(),
  decidedAt: z.iso.datetime().nullable(),
  note: z.string().max(ACTION_REQUEST_NOTE_MAX).nullable(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type ActionRequestSummary = z.infer<typeof actionRequestSummarySchema>;

/** Body of `POST …/action-requests/:id/approve|deny`. */
export const actionRequestDecisionSchema = z.strictObject({
  note: z.string().max(ACTION_REQUEST_NOTE_MAX).optional(),
});
export type ActionRequestDecision = z.infer<typeof actionRequestDecisionSchema>;

/**
 * Whether `userId` may decide a request of `kind` that `requestedById` made.
 * Only operators reach this; a requester cannot approve their own
 * non-`tool_use` request unless they are an admin (D18).
 */
export const mayDecideActionRequest = (args: {
  kind: ActionRequestKind;
  requestedById: string | null;
  userId: string;
  isAdmin: boolean;
}): boolean =>
  args.kind === 'tool_use' ||
  args.isAdmin ||
  args.requestedById === null ||
  args.requestedById !== args.userId;
