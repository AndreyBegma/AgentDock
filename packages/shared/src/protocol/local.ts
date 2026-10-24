import { z } from 'zod';
import {
  ACTION_REQUEST_SUMMARY_MAX,
  actionRequestSummarySchema,
  requestableActionRequestKindSchema,
} from '../action-requests/contracts';
import {
  CARD_EFFORTS,
  CARD_ESCALATION_NOTE_MAX,
  CARD_ESCALATION_REASONS,
  CARD_RECOMMENDABLE_MODELS,
} from '../assess/limits';
import { DESIGN_COMMENT_MAX } from '../design/limits';
import { taskDesignStatusSchema } from '../design/types';
import {
  REVIEW_FINDING_BODY_MAX,
  REVIEW_FINDING_SEVERITIES,
  REVIEW_FINDING_TITLE_MAX,
  REVIEW_FINDINGS_MAX,
  REVIEW_SUMMARY_MAX,
} from '../review/contracts';
import {
  pendingQuestionSchema,
  sessionMessageInputSchema,
  sessionMessageOutcomeSchema,
} from '../session-message/contracts';
import type { Role } from './commands';
import { issueLabelSchema } from './commands/queue';
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

/**
 * #845 D3: the Board's own refusals (`BOARD_ERROR`) a session's board tools
 * answer with unchanged, so the conductor obeys them by name. `message`
 * carries the board's message (for `move_refused`, its `BoardMoveRefusal`).
 * The board module checks each is a `BoardErrorCode`.
 */
export const LOCAL_BOARD_REFUSALS = [
  'dependency_open',
  'dependencies_unmerged',
  'design_not_approved',
  'stack_design_not_approved',
  'max_running',
  'card_running',
  'not_running',
  'wrong_column',
  'move_refused',
  'invalid_move',
  'card_completed',
  'no_profile',
  'command_unavailable',
  'policy_refused',
  // C-377 (ADR-0087): stacks and dependencies.
  'stack_refused',
  'dependency_cycle',
  'invalid_dependency',
] as const;

/**
 * C-377 (ADR-0087): the design routes' own refusals (`DESIGN_ERROR`) the
 * design tools answer with unchanged. The design module checks each is a
 * `DesignErrorCode`.
 */
export const LOCAL_DESIGN_REFUSALS = [
  'design_off',
  'design_busy',
  'no_open_comments',
  'design_approved',
  'task_frozen',
  'unsupported_runtime',
  'runner_outdated',
] as const;

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
  /**
   * `card.escalate` (#750 D9) on an Opus round, on a card that already
   * escalated, or in the A arm of `model-by-type`.
   */
  'not_escalatable',
  /** #884: `card.reviewReport` from a session that is not a running review step. */
  'not_a_review_session',
  /** `card.track` from a session that is not a person's own `manual` one (issue #282 D1). */
  'not_a_manual_session',
  /**
   * `card.finish` refused by the runner's artifact guard (#445 D8): the pull
   * request description or the summary is incomplete; `message` says what.
   */
  'artifact_incomplete',
  /** #845 D5: `card.move` to `completed` — only a person accepts (`card_accept`). */
  'completed_needs_person',
  /**
   * #845: `card.take` of a card another live session holds, or of a card
   * with an active Board Run round.
   */
  'card_taken',
  /** #845: `card.release` of a card the calling session neither holds nor queued. */
  'not_taken',
  /**
   * C-377 (ADR-0087): a design approve from a session that is not a person's
   * own `manual` one — approving stays a person's gate.
   */
  'needs_person',
  ...LOCAL_BOARD_REFUSALS,
  ...LOCAL_DESIGN_REFUSALS,
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
  labels: z.array(issueLabelSchema.max(50)).max(10).optional(),
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
   * `false`. The worker never sets it: the daemon drops it from every caller
   * and only its guard adds it (DA-18).
   */
  artifactIncomplete: z.boolean().optional(),
  /**
   * #845: a card a manual session took (`card.take`) has no worker to collect
   * it — the session pushed and opened the pull request itself and names it
   * here. The card moves to Finished with the PR recorded. Only a taken card's
   * session sends it; a card worker's finish ignores it.
   */
  pullRequestUrl: httpsGithubUrl.optional(),
});
export const localCardFinishResultSchema = z.object({
  /** The card's per-project number (`C-<number>`). */
  number: z.number().int().positive(),
  finished: z.literal(true),
  /**
   * #845 D2: a taken card's finish takes the session's next queued card, in
   * board order; `null` when none waits. Absent for a card worker's finish.
   */
  next: z.lazy(() => localTakenCardSchema.nullable()).optional(),
});

/**
 * `card.escalate` (#750 D8, D9): the card worker's `escalate_card` tool. Like
 * `card.finish`, the card is resolved from the request's `session.id`, never
 * from an argument; any other session is answered `not_a_card_session`. It
 * ends the round and — unless the card's model is a person's override —
 * relaunches the card on Opus in a fresh session; else `not_escalatable`.
 */
export const localCardEscalateArgsSchema = z.strictObject({
  reason: z.enum(CARD_ESCALATION_REASONS),
  /** What the worker found and why; added to the next round's prompt. */
  note: z.string().trim().min(1).max(CARD_ESCALATION_NOTE_MAX),
});
export const localCardEscalateResultSchema = z.object({
  /** The card's per-project number (`C-<number>`). */
  number: z.number().int().positive(),
  escalated: z.literal(true),
  /**
   * D9: an Opus round was started. `false` is D10 — the model is a person's
   * override, and the card waits in Finished with **Run on Opus**.
   */
  relaunched: z.boolean(),
});

/**
 * `card.reviewReport` (#884, ADR-0084 §4): a review session's `report_review`
 * tool, called once with every finding. The review run is resolved from the
 * request's `session.id` — the uuid the API gave the review session — never
 * from an argument; any other session is answered `not_a_review_session`.
 */
export const localReviewFindingSchema = z.strictObject({
  severity: z.enum(REVIEW_FINDING_SEVERITIES),
  /** Relative to the repository root. */
  file: z
    .string()
    .trim()
    .min(1)
    .max(1_000)
    .refine((f) => !f.startsWith('/') && !f.split('/').includes('..'), {
      message: 'must be relative to the repository root',
    })
    .optional(),
  /** 1-based, in `file`. */
  line: z.number().int().positive().optional(),
  title: z.string().trim().min(1).max(REVIEW_FINDING_TITLE_MAX),
  body: z.string().trim().max(REVIEW_FINDING_BODY_MAX),
});
export type LocalReviewFinding = z.infer<typeof localReviewFindingSchema>;

export const localCardReviewReportArgsSchema = z.strictObject({
  findings: z.array(localReviewFindingSchema).max(REVIEW_FINDINGS_MAX),
  summary: z.string().trim().max(REVIEW_SUMMARY_MAX).optional(),
});
export type LocalCardReviewReportArgs = z.infer<
  typeof localCardReviewReportArgsSchema
>;
export const localCardReviewReportResultSchema = z.object({
  /** The card's per-project number (`C-<number>`). */
  number: z.number().int().positive(),
  recorded: z.literal(true),
  blocking: z.number().int().nonnegative(),
  nits: z.number().int().nonnegative(),
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

// #845 (ADR-0083): a person's session works the Board.

/**
 * The Board's enums as the board tools carry them; `BOARD_COLUMNS`,
 * `CARD_ROUND_PHASES`, `CARD_PR_STATES` and `CARD_CI_STATES` in the board
 * module are these. Defined here because the board module imports this one.
 */
export const LOCAL_BOARD_COLUMNS = [
  'inbox',
  'todo',
  'in_progress',
  'finished',
  'completed',
] as const;
export const LOCAL_CARD_ROUND_PHASES = [
  'queued',
  'starting',
  'running',
  'waiting',
  'background',
  'finished',
  'ended',
  'failed',
  'cancelled',
] as const;
export const LOCAL_CARD_PR_STATES = [
  'open',
  'draft',
  'merged',
  'closed',
] as const;
export const LOCAL_CARD_CI_STATES = [
  'none',
  'pending',
  'green',
  'red',
] as const;
/** #845 D4: `CARD_MERGE_POLICIES` in the board module; the Prisma enum `CardMergePolicy`. */
export const LOCAL_CARD_MERGE_POLICIES = ['ask', 'agent', 'person'] as const;

const boardColumnSchema = z.enum(LOCAL_BOARD_COLUMNS);
const cardNumberSchema = z.number().int().positive();
/** A card is named by its per-project number — `C-42` is `{ card: 42 }`. */
const cardRefArgsSchema = z.strictObject({ card: cardNumberSchema });

/** Completed cards `board.list` returns, newest first (the column is endless). */
export const LOCAL_BOARD_LIST_COMPLETED_MAX = 20;
/** Rounds `board.card` returns, newest first. */
export const LOCAL_BOARD_CARD_ROUNDS_MAX = 10;
/** Feedback on a finished card (D9 of #242): `CARD_FEEDBACK_MAX` in the board module. */
export const LOCAL_CARD_FEEDBACK_MAX = 8_000;

/**
 * #845 D2, D10: the manual session that took a card. `alive` is the tracked
 * session's liveness (ADR-0024 D6); a card whose session is gone stays In
 * progress, "session ended", and Run or another `card.take` is offered.
 */
export const localCardTakenSchema = z.object({
  sessionId: z.string().min(1),
  alive: z.boolean(),
  /** The branch the session worked the card on; `null` before it named one. */
  branch: z.string().nullable(),
});
export type LocalCardTaken = z.infer<typeof localCardTakenSchema>;

// C-377 (ADR-0087): a person's session works stacks, designs and dependencies.

/** `STACK_TITLE_MAX` in the planner module. */
export const LOCAL_STACK_TITLE_MAX = 80;
/** `STACK_STAGE_TITLE_MAX` in the planner module. */
export const LOCAL_STACK_STAGE_TITLE_MAX = 80;
/** `INTAKE_SPLIT_MAX`: the most stages `stack.create` makes. */
export const LOCAL_STACK_STAGES_MAX = 8;
/** `BULK_CARDS_MAX`: the most cards one `stack.create` groups. */
export const LOCAL_STACK_CARDS_MAX = 100;
/** `MANUAL_STACK_CARDS_MIN`: a stack made by hand groups two cards or more. */
export const LOCAL_STACK_CARDS_MIN = 2;
/** Comments one design `revise` leaves before it revises. */
export const LOCAL_DESIGN_COMMENTS_MAX = 20;
/** `STACK_RUN_STATES` in the board module. */
export const LOCAL_STACK_RUN_STATES = [
  'running',
  'paused',
  'stopped',
  'done',
] as const;

const stackNumberSchema = z.number().int().positive();
const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .regex(/^[^\r\n]*$/, 'must be one line');
const stackRefArgsSchema = z.strictObject({ stack: stackNumberSchema });

/** A design as the stack and design tools brief it. */
export const localDesignBriefSchema = z.object({
  needed: z.boolean(),
  status: taskDesignStatusSchema,
  variantCount: z.number().int().nonnegative(),
  approvedRevisionId: z.string().min(1).nullable(),
  /** A Generate or Revise is under way. */
  busy: z.boolean(),
});
export type LocalDesignBrief = z.infer<typeof localDesignBriefSchema>;

/**
 * One stack as `board.list` and the stack methods answer it: its stages with
 * their cards by number, its design (null when it has none) and its run
 * (null before it was run).
 */
export const localStackSchema = z.object({
  number: stackNumberSchema,
  /** `S-<number>`. */
  label: z.string().min(1),
  title: z.string(),
  /** The column of its least advanced unfinished card. */
  column: boardColumnSchema,
  accepted: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  /** 0-based; null once every card is Completed. */
  currentStage: z.number().int().nonnegative().nullable(),
  stages: z.array(
    z.object({
      /** 0-based. */
      position: z.number().int().nonnegative(),
      title: z.string(),
      cards: z.array(cardNumberSchema),
    }),
  ),
  design: localDesignBriefSchema.nullable(),
  run: z
    .object({
      state: z.enum(LOCAL_STACK_RUN_STATES),
      queued: z.number().int().nonnegative(),
      waiting: z.number().int().nonnegative(),
      running: z.number().int().nonnegative(),
      pause: z
        .object({
          code: z.string().min(1),
          message: z.string(),
          card: cardNumberSchema.nullable(),
        })
        .nullable(),
    })
    .nullable(),
});
export type LocalStack = z.infer<typeof localStackSchema>;

/** One card as `board.list` answers it. */
export const localBoardListCardSchema = z.object({
  number: cardNumberSchema,
  /** `C-<number>`. */
  label: z.string().min(1),
  title: z.string(),
  kind: z.enum(LOCAL_CARD_KINDS),
  column: boardColumnSchema,
  /** The latest round's phase; `null` before the first Run. */
  roundPhase: z.enum(LOCAL_CARD_ROUND_PHASES).nullable(),
  /** The latest round holds the card (`isActiveRoundPhase`). */
  running: z.boolean(),
  /** The round's session shows a question selector — `board.card` has it. */
  waitingOnQuestion: z.boolean(),
  prNumber: z.number().int().positive().nullable(),
  prUrl: z.string().nullable(),
  prState: z.enum(LOCAL_CARD_PR_STATES).nullable(),
  ciState: z.enum(LOCAL_CARD_CI_STATES),
  mergedAt: nullableIso,
  /** CI or a protected path needs a person; nothing automated acts on it. */
  needsPerson: z.boolean(),
  /** The cards this one runs after, by number. */
  dependsOn: z.array(cardNumberSchema),
  /** Taken by a manual session (#845 D2); `null` otherwise. */
  taken: localCardTakenSchema.nullable(),
  /** The manual session this card is queued for (#845 D2); `null` otherwise. */
  queuedForSessionId: z.string().min(1).nullable(),
});
export type LocalBoardListCard = z.infer<typeof localBoardListCardSchema>;

/**
 * `board.list` (#845): the project's cards in board order, column by column.
 * Inbox only for a role that sees it; Completed at most
 * `LOCAL_BOARD_LIST_COMPLETED_MAX`, newest first.
 */
export const localBoardListArgsSchema = z.strictObject({
  column: boardColumnSchema.optional(),
});
export const localBoardListResultSchema = z.object({
  settings: z.object({
    maxRunning: z.number().int().positive(),
    /** Active rounds in the project now; `card.run` past `maxRunning` is `max_running`. */
    running: z.number().int().nonnegative(),
    cardMergePolicy: z.enum(LOCAL_CARD_MERGE_POLICIES),
  }),
  cards: z.array(localBoardListCardSchema),
  /** C-377: every stack of the project (with `column`, those in that column). */
  stacks: z.array(localStackSchema),
});

/** One round as `board.card` summarises it. */
export const localBoardCardRoundSchema = z.object({
  round: z.number().int().positive(),
  trigger: z.string(),
  phase: z.enum(LOCAL_CARD_ROUND_PHASES),
  /** The worker's `finish_card` summary; `null` until it finished. */
  summary: z.string().nullable(),
  startedAt: z.iso.datetime(),
  endedAt: nullableIso,
});

/** `board.card` (#845): one card in full. */
export const localBoardCardResultSchema = localBoardListCardSchema.extend({
  body: z.string(),
  branch: z.string().nullable(),
  issueUrl: z.string().nullable(),
  dependencies: z.array(
    z.object({
      number: cardNumberSchema,
      label: z.string().min(1),
      column: boardColumnSchema,
    }),
  ),
  /** Newest first, at most `LOCAL_BOARD_CARD_ROUNDS_MAX`. */
  rounds: z.array(localBoardCardRoundSchema),
  /** The failed checks while `ciState` is `red`; empty otherwise. */
  ciChecks: z.array(
    z.object({ name: z.string().min(1), link: z.string().nullable() }),
  ),
  /**
   * The question selector the latest round's session shows (ADR-0045) — only
   * for a project that ships content (ADR-0021); answer it with `card.message`.
   */
  question: pendingQuestionSchema.nullable(),
});

/**
 * #845 ADR-0083: how long the server holds one `board.wait` — under the
 * relay's `LOCAL_REQUEST_TIMEOUT_MS`, so a quiet board answers empty, never
 * `timeout`. The MCP tool's own wait (D8, up to `BOARD_WAIT_TIMEOUT_MAX_SEC`)
 * is a loop of these, each passing on the cursor.
 */
export const LOCAL_BOARD_WAIT_HOLD_MAX_SEC = 10;
/** D8: the longest `board_wait` a session asks for. */
export const BOARD_WAIT_TIMEOUT_MAX_SEC = 300;
/** An opaque cursor, at most this long (`encodeBoardWaitCursor`). */
export const LOCAL_BOARD_WAIT_CURSOR_MAX = 65_536;
/** Cards one `board.wait` may narrow to. */
export const LOCAL_BOARD_WAIT_CARDS_MAX = 50;

/**
 * `board.wait` (#845 D8): the board changes after `cursor`. Answers on the
 * first change or after `timeoutSec` (then `events` is empty), with the next
 * cursor either way. Without a cursor it answers at once with none, and a
 * cursor to start from. The same cursor twice reports the same changes
 * (a diff, not a queue — ADR-0083).
 */
export const localBoardWaitArgsSchema = z.strictObject({
  cursor: z.string().min(1).max(LOCAL_BOARD_WAIT_CURSOR_MAX).optional(),
  /** Only these cards; absent is every card outside Inbox and Completed. */
  cards: z
    .array(cardNumberSchema)
    .min(1)
    .max(LOCAL_BOARD_WAIT_CARDS_MAX)
    .optional(),
  timeoutSec: z
    .number()
    .int()
    .min(0)
    .max(LOCAL_BOARD_WAIT_HOLD_MAX_SEC)
    .default(LOCAL_BOARD_WAIT_HOLD_MAX_SEC),
});

const boardWaitEventBase = {
  card: cardNumberSchema,
  /** `C-<number>`. */
  label: z.string().min(1),
  title: z.string(),
};

/**
 * One change `board.wait` reports. `column` with `from: null` is a card that
 * appeared, `to: null` one that was deleted.
 */
export const localBoardWaitEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('column'),
    ...boardWaitEventBase,
    from: boardColumnSchema.nullable(),
    to: boardColumnSchema.nullable(),
  }),
  z.object({
    type: z.literal('round_ended'),
    ...boardWaitEventBase,
    round: z.number().int().positive(),
    /**
     * The phase the round ended in (`finished`, `ended`, `failed`,
     * `cancelled`); `null` when a newer round already started.
     */
    phase: z.enum(LOCAL_CARD_ROUND_PHASES).nullable(),
  }),
  z.object({
    type: z.literal('ci'),
    ...boardWaitEventBase,
    from: z.enum(LOCAL_CARD_CI_STATES),
    to: z.enum(LOCAL_CARD_CI_STATES),
  }),
  z.object({
    type: z.literal('pr_merged'),
    ...boardWaitEventBase,
    prNumber: z.number().int().positive().nullable(),
  }),
  z.object({
    type: z.literal('question'),
    ...boardWaitEventBase,
    question: pendingQuestionSchema,
  }),
]);
export type LocalBoardWaitEvent = z.infer<typeof localBoardWaitEventSchema>;

export const localBoardWaitResultSchema = z.object({
  events: z.array(localBoardWaitEventSchema),
  /** Pass it to the next `board.wait`; it survives a context compaction. */
  cursor: z.string().min(1).max(LOCAL_BOARD_WAIT_CURSOR_MAX),
});

/**
 * `card.create` (#845 D6): on the person's request the card goes to the top
 * of To Do; a card the session proposes on its own is a `candidate` and goes
 * to the Inbox (ADR-0058).
 */
export const localCardCreateArgsSchema = z.strictObject({
  title: localCardTrackArgsSchema.shape.title,
  body: z.string().max(LOCAL_CARD_BODY_MAX).optional(),
  kind: z.enum(LOCAL_CARD_KINDS).optional(),
  candidate: z.boolean().optional(),
});
export const localCardCreateResultSchema = localCardTrackResultSchema.extend({
  column: boardColumnSchema,
});

/** `card.run` (#845 D1): a Board Run; the Board's refusals come back unchanged. */
export const localCardRunArgsSchema = z.strictObject({
  card: cardNumberSchema,
  model: z.enum(CARD_RECOMMENDABLE_MODELS).optional(),
  effort: z.enum(CARD_EFFORTS).optional(),
});
export const localCardRunResultSchema = z.object({
  number: cardNumberSchema,
  /** The round the Run started. */
  round: z.number().int().positive(),
});

/**
 * `card.move` (#845): `index` is the place in the target column, 0 the top;
 * absent is the bottom. `completed` is always `completed_needs_person` (D5).
 */
export const localCardMoveArgsSchema = z.strictObject({
  card: cardNumberSchema,
  column: boardColumnSchema,
  index: z.number().int().nonnegative().optional(),
});
export const localCardMoveResultSchema = z.object({
  number: cardNumberSchema,
  column: boardColumnSchema,
});

/** `card.feedback` (#845 D3): a feedback round on a Finished card. */
export const localCardFeedbackArgsSchema = z.strictObject({
  card: cardNumberSchema,
  text: z.string().trim().min(1).max(LOCAL_CARD_FEEDBACK_MAX),
});
export const localCardFeedbackResultSchema = localCardRunResultSchema;

/**
 * `card.message` (#845 D7, ADR-0045): text to the card's running session,
 * or the answer to its question selector — `sessionMessageInputSchema` plus
 * the card.
 */
export const localCardMessageArgsSchema = z.discriminatedUnion('kind', [
  sessionMessageInputSchema.options[0].extend({ card: cardNumberSchema }),
  sessionMessageInputSchema.options[1].extend({ card: cardNumberSchema }),
  sessionMessageInputSchema.options[2].extend({ card: cardNumberSchema }),
]);
export const localCardMessageResultSchema = z.object({
  outcome: sessionMessageOutcomeSchema,
});

export const localCardStopResultSchema = z.object({
  number: cardNumberSchema,
  stopped: z.literal(true),
});

/**
 * A card the calling session holds or waits for — what it needs to start
 * working it (#845 D1, D2).
 */
export const localTakenCardSchema = z.object({
  number: cardNumberSchema,
  label: z.string().min(1),
  title: z.string(),
  body: z.string(),
  kind: z.enum(LOCAL_CARD_KINDS),
  /** The branch a previous session left (D10); `null` for a fresh card. */
  branch: z.string().nullable(),
});

/**
 * `card.take` (#845 D1, D2): a To Do card — or an In progress one whose
 * taking session is gone (D10) — moves to In progress bound to the caller.
 * When the caller already holds a card, this one is queued for it instead,
 * in board order, and `state` says so. A card with an active round, or held
 * by another live session, is `card_taken`.
 */
export const localCardTakeResultSchema = localTakenCardSchema.extend({
  state: z.enum(['taken', 'queued']),
  /** 1-based place among the caller's queued cards; `null` when taken. */
  queuePosition: z.number().int().positive().nullable(),
});

/**
 * `card.release` (#845 D10): the card goes back to To Do, its binding and
 * queue marker cleared. Releasing the held card takes the next queued one,
 * as a finish does.
 */
export const localCardReleaseResultSchema = z.object({
  number: cardNumberSchema,
  column: z.literal('todo'),
  next: localTakenCardSchema.nullable(),
});

// C-377 (ADR-0087): the stack, design and dependency methods.

/**
 * `stack.create` (C-377): one call groups the cards into a new stack with
 * every stage — each card of a stage depends on every card of the stage
 * before — in one transaction. A card in Inbox, in a stack already or not of
 * the project, or a dependency cycle, refuses the whole call.
 */
export const localStackCreateArgsSchema = z
  .strictObject({
    title: oneLine(LOCAL_STACK_TITLE_MAX).min(1),
    body: z.string().max(LOCAL_CARD_BODY_MAX).optional(),
    /** A shared design holds Run of every card until it is approved. */
    design: z.boolean().optional(),
    stages: z
      .array(
        z.strictObject({
          title: oneLine(LOCAL_STACK_STAGE_TITLE_MAX).optional(),
          cards: z.array(cardNumberSchema).min(1).max(LOCAL_STACK_CARDS_MAX),
        }),
      )
      .min(1)
      .max(LOCAL_STACK_STAGES_MAX),
  })
  .superRefine((args, ctx) => {
    const cards = args.stages.flatMap((s) => s.cards);
    if (cards.length < LOCAL_STACK_CARDS_MIN) {
      ctx.addIssue({
        code: 'custom',
        path: ['stages'],
        message: `A stack groups at least ${LOCAL_STACK_CARDS_MIN} cards`,
      });
    }
    if (cards.length > LOCAL_STACK_CARDS_MAX) {
      ctx.addIssue({
        code: 'custom',
        path: ['stages'],
        message: `A stack groups at most ${LOCAL_STACK_CARDS_MAX} cards`,
      });
    }
    if (new Set(cards).size !== cards.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['stages'],
        message: 'A card is in one stage only',
      });
    }
  });

/**
 * `stack.addCard` (C-377): a card in no stack joins a stage — an existing
 * one, or a new last one (`stage` = the number of stages).
 */
export const localStackAddCardArgsSchema = z.strictObject({
  stack: stackNumberSchema,
  card: cardNumberSchema,
  /** 0-based. */
  stage: z.number().int().min(0).max(LOCAL_STACK_STAGES_MAX),
});

/** `stack.removeCard` (C-377): the card leaves the stack and stays on the board. */
export const localStackRemoveCardArgsSchema = z.strictObject({
  stack: stackNumberSchema,
  card: cardNumberSchema,
});

/** `stack.update` (C-377): the title, the description and stage titles. */
export const localStackUpdateArgsSchema = z
  .strictObject({
    stack: stackNumberSchema,
    title: oneLine(LOCAL_STACK_TITLE_MAX).min(1).optional(),
    body: z.string().max(LOCAL_CARD_BODY_MAX).optional(),
    /** Each names a stage by its 0-based position; an empty title clears it. */
    stages: z
      .array(
        z.strictObject({
          position: z.number().int().min(0).max(LOCAL_STACK_STAGES_MAX),
          title: oneLine(LOCAL_STACK_STAGE_TITLE_MAX),
        }),
      )
      .min(1)
      .max(LOCAL_STACK_STAGES_MAX + 1)
      .optional(),
  })
  .refine(
    (args) =>
      args.title !== undefined ||
      args.body !== undefined ||
      args.stages !== undefined,
    { message: 'Nothing to change: give title, body or stages' },
  );

/** One revision of a design, as the design tools list it. */
export const localDesignRevisionSchema = z.object({
  id: z.string().min(1),
  /** 1-based. */
  variant: z.number().int().positive(),
  revision: z.number().int().positive(),
  title: z.string(),
  /** A variant not picked on approve. */
  archived: z.boolean(),
});

/**
 * `stack.designView` / `card.designView` (C-377): the design's state, its
 * revisions and its open comments — the `status` action of the design tools.
 */
export const localDesignViewSchema = localDesignBriefSchema.extend({
  owner: z.enum(['card', 'stack']),
  number: z.number().int().positive(),
  revisions: z.array(localDesignRevisionSchema),
  /** Comments no revision has addressed yet; Revise sends them. */
  openComments: z.array(
    z.object({
      id: z.string().min(1),
      revisionId: z.string().min(1),
      body: z.string(),
    }),
  ),
  /** Why the last batch ended without a revision; null at rest. */
  lastFailure: z
    .object({ reason: z.string().min(1), message: z.string() })
    .nullable(),
});
export type LocalDesignView = z.infer<typeof localDesignViewSchema>;

/** The design actions that write; `status` is the view method. */
export const LOCAL_DESIGN_ACTIONS = ['generate', 'approve', 'revise'] as const;

const designActionFields = {
  action: z.enum(LOCAL_DESIGN_ACTIONS),
  /**
   * `revise`: general comments left on `revisionId` (default the newest
   * revision of a variant still in play) before it revises.
   */
  comments: z
    .array(z.string().trim().min(1).max(DESIGN_COMMENT_MAX))
    .min(1)
    .max(LOCAL_DESIGN_COMMENTS_MAX)
    .optional(),
  /**
   * `approve`: the revision to approve — default the newest of the only
   * variant still in play; `revise`: the revision the comments are left on.
   */
  revisionId: z.string().min(1).max(64).optional(),
};

/**
 * `stack.design` / `card.design` (C-377): Generate, Approve or Revise, as
 * the design page does. Approve is a person's gate: a session that is not a
 * person's own `manual` one is `needs_person`.
 */
export const localStackDesignArgsSchema = z.strictObject({
  stack: stackNumberSchema,
  ...designActionFields,
});
export const localCardDesignArgsSchema = z.strictObject({
  card: cardNumberSchema,
  ...designActionFields,
});

/** `card.depend` / `card.undepend` (C-377): one dependency of a card. */
export const localCardDependArgsSchema = z
  .strictObject({ card: cardNumberSchema, dependsOn: cardNumberSchema })
  .refine((args) => args.card !== args.dependsOn, {
    message: 'A card does not depend on itself',
  });
export const localCardDependResultSchema = z.object({
  number: cardNumberSchema,
  /** The cards it runs after now, by number. */
  dependsOn: z.array(cardNumberSchema),
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
  'card.escalate': {
    args: localCardEscalateArgsSchema,
    result: localCardEscalateResultSchema,
    minRole: 'operator',
    needsProject: true,
  },
  'card.reviewReport': {
    args: localCardReviewReportArgsSchema,
    result: localCardReviewReportResultSchema,
    minRole: 'operator',
    needsProject: true,
  },
  'card.track': {
    args: localCardTrackArgsSchema,
    result: localCardTrackResultSchema,
    minRole: 'operator',
    needsProject: true,
  },
  // #845 D9: the read methods answer any session of the project; the
  // control methods only a person's own `manual` one (`not_a_manual_session`).
  'board.list': {
    args: localBoardListArgsSchema,
    result: localBoardListResultSchema,
    minRole: 'viewer',
    needsProject: true,
  },
  'board.card': {
    args: cardRefArgsSchema,
    result: localBoardCardResultSchema,
    minRole: 'viewer',
    needsProject: true,
  },
  'board.wait': {
    args: localBoardWaitArgsSchema,
    result: localBoardWaitResultSchema,
    minRole: 'viewer',
    needsProject: true,
  },
  'card.create': {
    args: localCardCreateArgsSchema,
    result: localCardCreateResultSchema,
    minRole: 'operator',
    needsProject: true,
  },
  'card.run': {
    args: localCardRunArgsSchema,
    result: localCardRunResultSchema,
    minRole: 'operator',
    needsProject: true,
  },
  'card.move': {
    args: localCardMoveArgsSchema,
    result: localCardMoveResultSchema,
    minRole: 'operator',
    needsProject: true,
  },
  'card.feedback': {
    args: localCardFeedbackArgsSchema,
    result: localCardFeedbackResultSchema,
    minRole: 'operator',
    needsProject: true,
  },
  'card.message': {
    args: localCardMessageArgsSchema,
    result: localCardMessageResultSchema,
    minRole: 'operator',
    needsProject: true,
  },
  'card.stop': {
    args: cardRefArgsSchema,
    result: localCardStopResultSchema,
    minRole: 'operator',
    needsProject: true,
  },
  'card.take': {
    args: cardRefArgsSchema,
    result: localCardTakeResultSchema,
    minRole: 'operator',
    needsProject: true,
  },
  'card.release': {
    args: cardRefArgsSchema,
    result: localCardReleaseResultSchema,
    minRole: 'operator',
    needsProject: true,
  },
  // C-377 (ADR-0087): the design views answer any session of the project;
  // the rest only a person's own `manual` one, as the #845 control methods.
  'stack.create': {
    args: localStackCreateArgsSchema,
    result: localStackSchema,
    minRole: 'operator',
    needsProject: true,
  },
  'stack.addCard': {
    args: localStackAddCardArgsSchema,
    result: localStackSchema,
    minRole: 'operator',
    needsProject: true,
  },
  'stack.removeCard': {
    args: localStackRemoveCardArgsSchema,
    result: localStackSchema,
    minRole: 'operator',
    needsProject: true,
  },
  'stack.update': {
    args: localStackUpdateArgsSchema,
    result: localStackSchema,
    minRole: 'operator',
    needsProject: true,
  },
  'stack.run': {
    args: stackRefArgsSchema,
    result: localStackSchema,
    minRole: 'operator',
    needsProject: true,
  },
  'stack.stop': {
    args: stackRefArgsSchema,
    result: localStackSchema,
    minRole: 'operator',
    needsProject: true,
  },
  'stack.designView': {
    args: stackRefArgsSchema,
    result: localDesignViewSchema,
    minRole: 'viewer',
    needsProject: true,
  },
  'stack.design': {
    args: localStackDesignArgsSchema,
    result: localDesignViewSchema,
    minRole: 'operator',
    needsProject: true,
  },
  'card.designView': {
    args: cardRefArgsSchema,
    result: localDesignViewSchema,
    minRole: 'viewer',
    needsProject: true,
  },
  'card.design': {
    args: localCardDesignArgsSchema,
    result: localDesignViewSchema,
    minRole: 'operator',
    needsProject: true,
  },
  'card.depend': {
    args: localCardDependArgsSchema,
    result: localCardDependResultSchema,
    minRole: 'operator',
    needsProject: true,
  },
  'card.undepend': {
    args: localCardDependArgsSchema,
    result: localCardDependResultSchema,
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
