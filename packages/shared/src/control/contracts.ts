import type {
  ControlCommandName,
  OrchestratorMode,
  OrchestratorPermissionMode,
  OrchestratorState,
  Runtime,
} from '../protocol';

/**
 * HTTP contracts of orchestrator and slot control
 * (docs/specs/17-orchestrator-and-slot-control.md "API").
 */

/** D10: `requested` until the runner answers; `unknown` when it never did. */
export const COMMAND_RUN_STATUSES = [
  'requested',
  'ok',
  'error',
  'unknown',
] as const;
export type CommandRunStatus = (typeof COMMAND_RUN_STATUSES)[number];

/** The control commands that get a `command_runs` row (status is a read, D10). */
export type CommandRunCommand = Exclude<
  ControlCommandName,
  'orchestrator.status'
>;

/** One control command sent from the UI, and its outcome. */
export interface CommandRunView {
  id: string;
  projectId: string;
  command: CommandRunCommand;
  slot: string | null;
  status: CommandRunStatus;
  /** The args as sent — a message's text included. */
  args: Record<string, unknown>;
  /** The runner's result when `ok`. */
  result: Record<string, unknown> | null;
  /** `{ code, message? }` when `error`: a control error code. */
  error: { code: ControlErrorCode; message?: string } | null;
  /** Null when the user was deleted. */
  user: { id: string; email: string } | null;
  requestedAt: string;
  finishedAt: string | null;
}

export const COMMAND_RUN_LIST_DEFAULT_LIMIT = 50;
export const COMMAND_RUN_LIST_MAX_LIMIT = 200;

/** `GET /projects/:id/command-runs` — newest first. */
export interface CommandRunListQuery {
  limit?: number;
  /** `nextCursor` of the previous page. */
  cursor?: string;
}

export interface CommandRunPage {
  items: CommandRunView[];
  nextCursor: string | null;
}

/** `POST /projects/:id/orchestrator/start`. Unset fields take the project's settings. */
export interface OrchestratorStartRequest {
  mode: OrchestratorMode;
  /** A `runtime_profiles` id on the project's runner. */
  profileId?: string;
  model?: string;
  /** `bypassPermissions` here needs the admin role (D3). */
  permissionMode?: OrchestratorPermissionMode;
}

/** `POST /projects/:id/slots/:slot/message`. */
export interface SlotMessageRequest {
  text: string;
}

/** A profile as the settings tab lists it. */
export interface OrchestratorProfileRef {
  id: string;
  key: string;
  label: string;
  runtime: Runtime;
}

/** `GET /projects/:id/orchestrator/settings` (D3). */
export interface OrchestratorSettingsView {
  /** The profile set here; null falls back to the project's default profile. */
  profileId: string | null;
  model: string;
  permissionMode: OrchestratorPermissionMode;
  /** What a start without overrides would use; null when no profile is set anywhere. */
  effectiveProfile: OrchestratorProfileRef | null;
  updatedAt: string | null;
  updatedBy: { id: string; email: string } | null;
}

/**
 * `PUT /projects/:id/orchestrator/settings` — only the fields sent change.
 * `profileId: null` falls back to the project's default profile;
 * `permissionMode: bypassPermissions` needs the admin role (D3).
 */
export interface OrchestratorSettingsRequest {
  profileId?: string | null;
  model?: string;
  permissionMode?: OrchestratorPermissionMode;
}

/** `GET /projects/:id/orchestrator/status` (D5), read live from the runner. */
export interface OrchestratorStatusView {
  present: boolean;
  state: OrchestratorState;
  session: string | null;
  startedAt: string | null;
}

/** Stable codes in the `error` field of a control route's error body. */
export const CONTROL_ERROR = {
  notFound: 'not_found',
  forbidden: 'forbidden',
  /** A `:slot` that is not `^[a-z0-9][a-z0-9-]*$`; nothing was sent. */
  invalidArgs: 'invalid_args',
  /** Neither the request, the settings nor the project names a profile. */
  noProfile: 'no_profile',
  /** The profile is not on the project's runner, is missing, or the runner does not know it. */
  unknownProfile: 'unknown_profile',
  /** A `codex` profile: the orchestrator runs on Claude only (M4.3). */
  unsupportedRuntime: 'unsupported_runtime',
  /** The orchestrator's tmux session already exists (D2). */
  alreadyRunning: 'already_running',
  /** The runner has no open socket; nothing was sent. */
  runnerOffline: 'runner_offline',
  /** The command was sent and no result came back in time; the run is `unknown`. */
  runnerTimeout: 'runner_timeout',
  /** The root or the slot's worktree is not this project's. */
  pathNotAllowed: 'path_not_allowed',
  /** The runner answered with an error not mapped to its own code. */
  runnerError: 'runner_error',
} as const;
export type ControlErrorCode =
  (typeof CONTROL_ERROR)[keyof typeof CONTROL_ERROR];

export interface ControlErrorBody {
  statusCode: number;
  error: ControlErrorCode;
  message: string;
  /** The run this refusal or failure was recorded as, when one was created. */
  commandRunId?: string;
}

/** Live event on `project:<id>` whenever a run is created or finishes. */
export const COMMAND_RUN_LIVE_EVENT = 'command_run.updated';

/**
 * Its data: the run without `args`, which can hold a 16 KB message that
 * escaping could push past the live frame limit. Read them over REST.
 */
export type CommandRunLiveEvent = Omit<CommandRunView, 'args'>;

/**
 * Live event on `project:<id>` after a message reached a worker's worktree
 * (D8): the message bypassed the orchestrator. Durable record: the run.
 */
export const SLOT_MESSAGE_SENT_LIVE_EVENT = 'slot.message_sent';

export interface SlotMessageSentEvent {
  projectId: string;
  slot: string;
  commandRunId: string;
  userId: string;
  /** True when the worker's session was live and the prompt was typed into it. */
  delivered: boolean;
  at: string;
}
