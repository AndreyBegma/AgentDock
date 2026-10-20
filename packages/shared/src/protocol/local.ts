import { z } from 'zod';
import {
  ACTION_REQUEST_SUMMARY_MAX,
  actionRequestSummarySchema,
  requestableActionRequestKindSchema,
} from '../action-requests/contracts';
import type { Role } from './commands';
import { httpsGithubUrl } from './github-url';

/**
 * Runner-initiated requests (ADR-0020 §4, docs/specs/201-claude-code-integration.md
 * D6–D8). The `nautelle` plugin's hook and MCP processes ask the daemon over
 * its local socket; the daemon relays as `local.request` and the server
 * answers `local.response`. The mirror of the command allowlist (ADR-0010):
 * the server answers only the methods here, with validated args, and only
 * when the runner's local user has `minRole` on the project — capped at
 * `operator` whatever the user's role (D8).
 *
 * The project is never an argument. The daemon correlates the session's cwd
 * to a watched project (D9) and sends its id beside the args; the server
 * checks that the project is one this runner watches.
 */

/** The server's and the daemon's deadline for one local request (D6). */
export const LOCAL_REQUEST_TIMEOUT_MS = 15_000;

/** `local.request`s the server answers at once for one runner; one more is `busy` (C-137). */
export const LOCAL_MAX_CONCURRENT_PER_RUNNER = 32;

/** A local request never acts with more than this role (D8). */
export const LOCAL_ROLE_CAP: Role = 'operator';

export const localErrorCodeSchema = z.enum([
  /** The method is not in this allowlist. */
  'unknown_method',
  /** The args failed the method's schema. */
  'invalid_args',
  /** No local user, not a member, or a role below the method's `minRole`. */
  'forbidden',
  /** A project method from a session outside every watched root (D9). */
  'no_project',
  /** The WSS is down; the daemon answers this itself and spools nothing (D6). */
  'runner_offline',
  /** The daemon is not running; hook and MCP processes answer this themselves. */
  'daemon_unavailable',
  /** No answer within `LOCAL_REQUEST_TIMEOUT_MS`. */
  'timeout',
  /** A hard-stop budget refuses the write. */
  'budget_exceeded',
  /** The id or target does not exist in that project. */
  'not_found',
  /** The runner already has `LOCAL_MAX_CONCURRENT_PER_RUNNER` requests in flight. */
  'busy',
  /** The domain service failed; `message` carries no stack trace. */
  'internal',
  /** `card.finish` from a session that is not a board card's worker (issue #242). */
  'not_a_card_session',
  /** `card.track` from a session that is not a person's own `manual` one (issue #282 D1). */
  'not_a_manual_session',
]);
export type LocalErrorCode = z.infer<typeof localErrorCodeSchema>;

export interface LocalMethodDefinition<
  Args extends z.ZodType = z.ZodType,
  Result extends z.ZodType = z.ZodType,
> {
  args: Args;
  result: Result;
  minRole: Role;
  /** False only for methods that make sense without a project. */
  needsProject: boolean;
}

const noArgs = z.strictObject({});
const limit = z.number().int().min(1).max(50).default(10);
const nullableIso = z.iso.datetime().nullable();

/** `context.sessionStart` (D16): the hook prints `text` as `additionalContext`. */
export const SESSION_START_CONTEXT_MAX_CHARS = 2_000;

export const localSessionStartArgsSchema = z.strictObject({
  gitBranch: z.string().min(1).max(255).optional(),
});
export const localSessionStartResultSchema = z.object({
  text: z.string().max(SESSION_START_CONTEXT_MAX_CHARS),
});

export const localFleetStatusResultSchema = z.object({
  orchestrator: z.object({
    present: z.boolean(),
    state: z.string().nullable(),
  }),
  slots: z.array(
    z.object({
      name: z.string(),
      issue: z.number().int().nullable(),
      state: z.string(),
      lastActivityAt: nullableIso,
    }),
  ),
});

export const localQueueListResultSchema = z.object({
  items: z.array(
    z.object({
      number: z.number().int().positive(),
      title: z.string(),
      labels: z.array(z.string()),
      ready: z.boolean(),
      inFlight: z.boolean(),
    }),
  ),
});

export const localBudgetRemainingResultSchema = z.object({
  budgets: z.array(
    z.object({
      scope: z.enum(['project', 'user']),
      period: z.enum(['day', 'week', 'month']),
      action: z.enum(['alert', 'stop']),
      /** Decimal strings, as budgets report money. */
      limitUsd: z.string(),
      spentUsd: z.string(),
      remainingUsd: z.string(),
      resetsAt: z.iso.datetime(),
    }),
  ),
});

export const localApprovalsListResultSchema = z.object({
  items: z.array(
    z.object({
      pr: z.number().int().positive(),
      title: z.string(),
      status: z.string(),
      slot: z.string().nullable(),
    }),
  ),
  actionRequests: z.array(actionRequestSummarySchema),
});

export const localActivityRecentResultSchema = z.object({
  items: z.array(
    z.object({
      ts: z.iso.datetime(),
      type: z.string(),
      title: z.string(),
      severity: z.string(),
    }),
  ),
});

export const localSessionsRecentResultSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      origin: z.string(),
      title: z.string().nullable(),
      gitBranch: z.string().nullable(),
      liveState: z.string().nullable(),
      lastEventAt: z.iso.datetime(),
    }),
  ),
});

export const localIssueCreateArgsSchema = z.strictObject({
  title: z.string().min(1).max(256),
  body: z.string().max(20_000),
  labels: z.array(z.string().min(1).max(50)).max(10).optional(),
  queue: z.boolean(),
});
/**
 * `queued` is never true for a session's issue (C-112): asked to queue, the
 * API files it unlabelled with an `issue_queue` request a person decides —
 * `actionRequestId` and `waiting` say so.
 */
export const localIssueResultSchema = z.object({
  number: z.number().int().positive(),
  url: httpsGithubUrl,
  queued: z.boolean(),
  actionRequestId: z.string().min(1).optional(),
  waiting: z.string().optional(),
});

/** Server event types `activity.note` and `handoff.create` record (ADR-0014). */
export const MANUAL_NOTE_EVENT = 'manual.note';
export const MANUAL_HANDOFF_EVENT = 'manual.handoff';

export const LOCAL_NOTE_MAX = 2_000;
export const localNoteArgsSchema = z.strictObject({
  text: z.string().min(1).max(LOCAL_NOTE_MAX),
});

export const localHandoffArgsSchema = z.strictObject({
  title: z.string().min(1).max(256),
  body: z.string().max(18_000),
  branch: z.string().min(1).max(255),
});

/** `args` is checked against `actionRequestArgsSchemas[kind]` by the server. */
export const localActionRequestArgsSchema = z.strictObject({
  kind: requestableActionRequestKindSchema,
  args: z.record(z.string(), z.unknown()),
  summary: z.string().min(1).max(ACTION_REQUEST_SUMMARY_MAX),
});

export const localActionStatusArgsSchema = z.strictObject({
  id: z.string().min(1).max(64),
});

export const localAwaySetArgsSchema = z.strictObject({ on: z.boolean() });

/** The `finish_card` summary; `CARD_SUMMARY_MAX` in the board module. */
export const LOCAL_CARD_SUMMARY_MAX = 4_000;

/**
 * `card.finish` (issue #242 D6): the card worker's `finish_card` tool. The
 * card is resolved from the request's `session.id` — the uuid the API gave
 * the card — never from an argument; any other session is answered
 * `not_a_card_session`.
 */
export const localCardFinishArgsSchema = z.strictObject({
  summary: z.string().trim().min(1).max(LOCAL_CARD_SUMMARY_MAX),
  /**
   * #445 D8: set by the runner's artifact guard when it accepts a finish after
   * 2 rejections in the round; stored as `runs.artifactIncomplete`. Absent is
   * `false`. The worker never sets it — the guard does.
   */
  artifactIncomplete: z.boolean().optional(),
});
export const localCardFinishResultSchema = z.object({
  /** The card's per-project number (`C-<number>`). */
  number: z.number().int().positive(),
  finished: z.literal(true),
});

/**
 * A card's title and body limits and its kinds; `BOARD_CARD_TITLE_MAX`,
 * `BOARD_CARD_BODY_MAX` and `BOARD_CARD_KINDS` in the board module. Defined
 * here because the board module imports this one.
 */
export const LOCAL_CARD_TITLE_MAX = 200;
export const LOCAL_CARD_BODY_MAX = 20_000;
export const LOCAL_CARD_KINDS = ['feature', 'bug'] as const;

/**
 * `card.track` (issue #282 D1, ADR-0030 §1): the `track_card` tool of a
 * person's own terminal session. The card is resolved from the request's
 * `session.id`: the first call creates card C-n In progress with
 * `source: terminal`, linked to the session; a later call from the same
 * session updates that card's title and body (and `kind`, when given) and
 * never creates a second one. Any session that is not `manual` is answered
 * `not_a_manual_session`.
 */
export const localCardTrackArgsSchema = z.strictObject({
  title: z
    .string()
    .trim()
    .min(1)
    .max(LOCAL_CARD_TITLE_MAX)
    .refine((title) => !/[\r\n]/.test(title), 'title must be one line'),
  body: z.string().max(LOCAL_CARD_BODY_MAX).optional(),
  /** Only when it is obvious; absent leaves it to the normalization (#271 D9). */
  kind: z.enum(LOCAL_CARD_KINDS).optional(),
});
export const localCardTrackResultSchema = z.object({
  /** The card's per-project number. */
  number: z.number().int().positive(),
  /** `C-<number>`. */
  label: z.string().min(1),
  /** The card on the Board, in the web app. */
  url: z.string().min(1),
});

/**
 * The local method allowlist (D7). Each later change adds its method here and
 * its handler to the API's router in the same change.
 */
export const localMethods = {
  'context.sessionStart': {
    args: localSessionStartArgsSchema,
    result: localSessionStartResultSchema,
    minRole: 'viewer',
    needsProject: true,
  },
  'fleet.status': {
    args: noArgs,
    result: localFleetStatusResultSchema,
    minRole: 'viewer',
    needsProject: true,
  },
  'queue.list': {
    args: z.strictObject({ limit }),
    result: localQueueListResultSchema,
    minRole: 'viewer',
    needsProject: true,
  },
  'budget.remaining': {
    args: noArgs,
    result: localBudgetRemainingResultSchema,
    minRole: 'viewer',
    needsProject: true,
  },
  'approvals.list': {
    args: noArgs,
    result: localApprovalsListResultSchema,
    minRole: 'viewer',
    needsProject: true,
  },
  'activity.recent': {
    args: z.strictObject({ limit }),
    result: localActivityRecentResultSchema,
    minRole: 'viewer',
    needsProject: true,
  },
  'sessions.recent': {
    args: z.strictObject({ limit }),
    result: localSessionsRecentResultSchema,
    minRole: 'viewer',
    needsProject: true,
  },
  'action.status': {
    args: localActionStatusArgsSchema,
    result: actionRequestSummarySchema,
    minRole: 'viewer',
    needsProject: true,
  },
  'issue.create': {
    args: localIssueCreateArgsSchema,
    result: localIssueResultSchema,
    minRole: 'operator',
    needsProject: true,
  },
  'activity.note': {
    args: localNoteArgsSchema,
    result: z.object({ recorded: z.literal(true) }),
    minRole: 'operator',
    needsProject: true,
  },
  'handoff.create': {
    args: localHandoffArgsSchema,
    result: localIssueResultSchema,
    minRole: 'operator',
    needsProject: true,
  },
  'action.request': {
    args: localActionRequestArgsSchema,
    result: actionRequestSummarySchema,
    minRole: 'operator',
    needsProject: true,
  },
  'card.finish': {
    args: localCardFinishArgsSchema,
    result: localCardFinishResultSchema,
    minRole: 'operator',
    needsProject: true,
  },
  'card.track': {
    args: localCardTrackArgsSchema,
    result: localCardTrackResultSchema,
    minRole: 'operator',
    needsProject: true,
  },
  /** Away mode belongs to the runner, not a project (D17). */
  'away.set': {
    args: localAwaySetArgsSchema,
    result: z.object({ awayMode: z.boolean() }),
    minRole: 'operator',
    needsProject: false,
  },
} as const satisfies Record<string, LocalMethodDefinition>;

export type LocalMethodName = keyof typeof localMethods;
export type LocalMethodArgs<N extends LocalMethodName> = z.infer<
  (typeof localMethods)[N]['args']
>;
export type LocalMethodResult<N extends LocalMethodName> = z.infer<
  (typeof localMethods)[N]['result']
>;

export const localMethodNames = Object.keys(localMethods) as LocalMethodName[];

export const isLocalMethodName = (name: string): name is LocalMethodName =>
  Object.hasOwn(localMethods, name);

/** Matches the envelope's `session` (D10): absent when the daemon could not tell. */
const localSessionSchema = z.object({
  runtime: z.string().min(1).max(32),
  id: z.string().min(1).max(200),
});

// Wire messages

/**
 * Runner → server. `method` and `args` are loose here, as in `command`: an
 * unknown method must reach the router and be answered `unknown_method`.
 * `projectId` is the daemon's correlation (D9), absent outside watched roots.
 */
export const localRequestMessageSchema = z.object({
  type: z.literal('local.request'),
  id: z.string().min(1).max(128),
  method: z.string().min(1).max(64),
  args: z.unknown(),
  projectId: z.string().min(1).max(64).optional(),
  session: localSessionSchema.optional(),
  /** Which plugin process asked; recorded in the audit `meta.via` (D8). */
  via: z.enum(['mcp', 'hook', 'cli']),
});
export type LocalRequestMessage = z.infer<typeof localRequestMessageSchema>;

/** Server → runner. */
export const localResponseMessageSchema = z
  .object({
    type: z.literal('local.response'),
    id: z.string().min(1).max(128),
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z
      .object({
        code: localErrorCodeSchema,
        message: z.string().max(1_000).optional(),
      })
      .optional(),
  })
  .refine((m) => m.ok === (m.error === undefined), {
    message: '`error` is required when ok is false and forbidden when true',
    path: ['error'],
  });
export type LocalResponseMessage = z.infer<typeof localResponseMessageSchema>;

export type ParsedLocalRequest =
  | { ok: true; method: LocalMethodName; args: unknown }
  | {
      ok: false;
      error: { code: 'unknown_method' | 'invalid_args'; message: string };
    };

/** Resolves a `local.request` against the allowlist and validates its args. */
export const parseLocalRequest = (
  method: string,
  args: unknown,
): ParsedLocalRequest => {
  if (!isLocalMethodName(method)) {
    return {
      ok: false,
      error: { code: 'unknown_method', message: `unknown method: ${method}` },
    };
  }
  const parsed = localMethods[method].args.safeParse(args);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: 'invalid_args', message: z.prettifyError(parsed.error) },
    };
  }
  return { ok: true, method, args: parsed.data };
};
