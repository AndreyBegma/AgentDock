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
  'issue_queue',
  'card_accept',
]);
export type ActionRequestKind = z.infer<typeof actionRequestKindSchema>;
export const ACTION_REQUEST_KINDS = actionRequestKindSchema.options;

/**
 * The kinds a session may ask for with `action.request`. `issue_queue` is not
 * one: the API creates it itself when a session files an issue for the fleet
 * (C-112), bound to the issue it just created.
 */
export const requestableActionRequestKindSchema =
  actionRequestKindSchema.exclude(['issue_queue']);
export type RequestableActionRequestKind = z.infer<
  typeof requestableActionRequestKindSchema
>;

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
  /** Expiring only leaves the issue unqueued; a week covers a weekend away. */
  issue_queue: 7 * 24 * 60 * 60_000,
  /** Expiring leaves the card in Finished, where a person accepts it anyway. */
  card_accept: 7 * 24 * 60 * 60_000,
};

/** The `PermissionRequest` hook polls `action.status` this often… */
export const ACTION_REQUEST_POLL_MS = 2_000;
/** …for at most this long, inside its 300 s hook timeout (D17). */
export const ACTION_REQUEST_HOOK_WAIT_MS = 280_000;

export const ACTION_REQUEST_SUMMARY_MAX = 500;
export const ACTION_REQUEST_NOTE_MAX = 1_000;
/**
 * The shown budget of a `tool_use` request's redacted tool input (D17,
 * C-114): head and tail together, the truncation marker between them
 * included, when the input is longer.
 */
export const ACTION_REQUEST_TOOL_INPUT_MAX = 1_000;

/** The issue title kept on an `issue_queue` request (GitHub's own limit). */
export const ACTION_REQUEST_ISSUE_TITLE_MAX = 256;

/**
 * `args` per kind. Strict: the API executes the non-`tool_use` kinds, so
 * nothing may ride along. The project is never in `args` — the API resolves
 * it from the runner's correlation (D9).
 */
export const actionRequestArgsSchemas = {
  tool_use: z
    .strictObject({
      toolName: z.string().min(1).max(200),
      /**
       * The redacted tool input, sent independent of content shipping
       * (C-114, D-08): whole, or head and tail with a marker between them.
       */
      input: z.string().max(ACTION_REQUEST_TOOL_INPUT_MAX).optional(),
      /** `input` is head and tail of a longer redacted input. */
      truncated: z.boolean().optional(),
      /** The full redacted input's length, in UTF-16 code units. */
      fullLength: z.number().int().nonnegative().optional(),
      /** SHA-256 (hex) of the full redacted input, UTF-8 encoded. */
      sha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
      /** The hook sent no tool input: the person sees the tool name only. */
      preview: z.literal('none').optional(),
    })
    .refine((args) => !(args.preview === 'none' && args.input !== undefined), {
      message: "a request with preview 'none' carries no input",
    }),
  orchestrator_start: z.strictObject({
    mode: z.enum(['start', 'next']).default('start'),
  }),
  orchestrator_stop: z.strictObject({}),
  pr_approve: z.strictObject({
    pr: z.number().int().positive(),
  }),
  issue_queue: z.strictObject({
    issue: z.number().int().positive(),
    title: z.string().max(ACTION_REQUEST_ISSUE_TITLE_MAX),
    url: z.url({ protocol: /^https?$/ }),
    /** The session that filed it (its Nautelle id), when the API knows it. */
    session: z.string().min(1).max(64).nullable(),
  }),
  /**
   * #845 D5: Finished → Completed is a person's (ADR-0024 §6, ADR-0030).
   * Approving runs the Board's `accept`; `merge` also merges the card's PR
   * while it is still open (merge policy `person`).
   */
  card_accept: z.strictObject({
    card: z.number().int().positive(),
    merge: z.boolean().optional(),
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

/** The issue of an `issue_queue` request; null for another kind or bad args. */
export const issueQueueArgsOf = (request: {
  kind: ActionRequestKind;
  args: unknown;
}): ActionRequestArgs<'issue_queue'> | null => {
  if (request.kind !== 'issue_queue') return null;
  const parsed = actionRequestArgsSchemas.issue_queue.safeParse(request.args);
  return parsed.success ? parsed.data : null;
};

/** The card title kept on a `card_accept` request (`BOARD_CARD_TITLE_MAX`). */
export const ACTION_REQUEST_CARD_TITLE_MAX = 200;

/**
 * The stored `args` of a `card_accept` request: what the session asked for
 * plus the card as the API read it when it was created — what the approver
 * is shown ("Accept C-<n> <title>", the PR, "and merge #<pr>"). Never taken
 * from the session.
 */
export const cardAcceptBoundArgsSchema = z.strictObject({
  card: z.number().int().positive(),
  merge: z.boolean().optional(),
  title: z.string().max(ACTION_REQUEST_CARD_TITLE_MAX),
  prNumber: z.number().int().positive().nullable(),
  prUrl: z.url({ protocol: /^https?$/ }).nullable(),
});
export type CardAcceptBoundArgs = z.infer<typeof cardAcceptBoundArgsSchema>;

/** The bound card of a `card_accept` request; null for another kind or bad args. */
export const cardAcceptArgsOf = (request: {
  kind: ActionRequestKind;
  args: unknown;
}): CardAcceptBoundArgs | null => {
  if (request.kind !== 'card_accept') return null;
  const parsed = cardAcceptBoundArgsSchema.safeParse(request.args);
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
 * `orchestrator_*` or `pr_approve` request unless they are an admin (D18).
 * `issue_queue` (C-112) and `card_accept` (#845 D5) only need a person, not
 * a second one.
 */
export const mayDecideActionRequest = (args: {
  kind: ActionRequestKind;
  requestedById: string | null;
  userId: string;
  isAdmin: boolean;
}): boolean =>
  args.kind === 'tool_use' ||
  // The person who would self-approve could have queued it from the web.
  args.kind === 'issue_queue' ||
  // …or accepted the card on the Board.
  args.kind === 'card_accept' ||
  args.isAdmin ||
  args.requestedById === null ||
  args.requestedById !== args.userId;
