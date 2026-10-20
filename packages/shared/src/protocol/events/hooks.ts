import { z } from 'zod';
import type { RunnerEvent } from '../envelope';

/**
 * Events of the `nautelle` Claude Code plugin's hooks
 * (docs/specs/201-claude-code-integration.md D11, ADR-0020), source `hook`.
 * The envelope's `session: { runtime: 'claude', id }` carries Claude Code's
 * `session_id`.
 *
 * Hooks report liveness and attribution only. They never send `llm.request`,
 * `turn.*` or `tool.call`: usage stays with OTel and transcripts (ADR-0003),
 * so nothing is counted twice.
 *
 * Content (`content`, `input`, `output`, `response`) is present only when the
 * runner correlated the session to a project that ships content, and is
 * redacted and capped on the runner before the spool (ADR-0021).
 */

export const HOOK_SESSION_STARTED_EVENT = 'hook.session_started';
export const HOOK_PROMPT_SUBMITTED_EVENT = 'hook.prompt_submitted';
export const HOOK_TOOL_FINISHED_EVENT = 'hook.tool_finished';
export const HOOK_PERMISSION_REQUESTED_EVENT = 'hook.permission_requested';
export const HOOK_NOTIFICATION_EVENT = 'hook.notification';
export const HOOK_STOPPED_EVENT = 'hook.stopped';
/** #494, #449 D8: Claude Code is about to compact the session. */
export const HOOK_PRE_COMPACT_EVENT = 'hook.pre_compact';
export const HOOK_SESSION_ENDED_EVENT = 'hook.session_ended';

export const HOOK_EVENT_TYPES = [
  HOOK_SESSION_STARTED_EVENT,
  HOOK_PROMPT_SUBMITTED_EVENT,
  HOOK_TOOL_FINISHED_EVENT,
  HOOK_PERMISSION_REQUESTED_EVENT,
  HOOK_NOTIFICATION_EVENT,
  HOOK_STOPPED_EVENT,
  HOOK_PRE_COMPACT_EVENT,
  HOOK_SESSION_ENDED_EVENT,
] as const;
export type HookEventType = (typeof HOOK_EVENT_TYPES)[number];

/**
 * The `nautelle-runner hook <name>` arguments the plugin's `hooks.json`
 * passes, and the Claude Code hook each one is declared on (D12). The CLI
 * name is kebab-case.
 */
export const HOOK_CLI_NAMES = {
  'session-start': 'SessionStart',
  'permission-request': 'PermissionRequest',
  'user-prompt-submit': 'UserPromptSubmit',
  'post-tool-use': 'PostToolUse',
  'post-tool-use-failure': 'PostToolUseFailure',
  notification: 'Notification',
  stop: 'Stop',
  'pre-compact': 'PreCompact',
  'session-end': 'SessionEnd',
} as const;
export type HookCliName = keyof typeof HOOK_CLI_NAMES;
export const hookCliNameSchema = z.enum(
  Object.keys(HOOK_CLI_NAMES) as [HookCliName, ...HookCliName[]],
);

/** The event each CLI name emits. `permission-request` emits before it decides. */
export const HOOK_CLI_EVENT: Record<HookCliName, HookEventType> = {
  'session-start': HOOK_SESSION_STARTED_EVENT,
  'permission-request': HOOK_PERMISSION_REQUESTED_EVENT,
  'user-prompt-submit': HOOK_PROMPT_SUBMITTED_EVENT,
  'post-tool-use': HOOK_TOOL_FINISHED_EVENT,
  'post-tool-use-failure': HOOK_TOOL_FINISHED_EVENT,
  notification: HOOK_NOTIFICATION_EVENT,
  stop: HOOK_STOPPED_EVENT,
  'pre-compact': HOOK_PRE_COMPACT_EVENT,
  'session-end': HOOK_SESSION_ENDED_EVENT,
};

/** Hooks that Claude Code waits on; every other one is declared `async` (D12). */
export const SYNC_HOOK_CLI_NAMES: readonly HookCliName[] = [
  'session-start',
  'permission-request',
];

/** Characters of one content text after redaction (ADR-0021 §4). */
export const HOOK_CONTENT_MAX_CHARS = 16 * 1024;

const id = z.string().min(1).max(200);
const name = z.string().min(1).max(200);
const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => p.startsWith('/'), { message: 'must be an absolute path' });

/** A branch name: no whitespace, control characters or shell syntax. */
const gitBranchSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._/+@-]+$/, 'must be a git branch name');

/** Redacted text, cut to `HOOK_CONTENT_MAX_CHARS` and marked when it was. */
export const hookContentSchema = z.strictObject({
  text: z.string().max(HOOK_CONTENT_MAX_CHARS),
  truncated: z.boolean(),
});
export type HookContent = z.infer<typeof hookContentSchema>;

/** Claude Code's `SessionStart.source`. */
export const hookStartSourceSchema = z.enum([
  'startup',
  'resume',
  'clear',
  'compact',
  'fork',
]);

/**
 * A tmux session `nautelle-runner claude` created (D23); one started before
 * the rename keeps its `agentdock-` name (ADR-0073).
 */
export const MANUAL_TMUX_SESSION_PREFIX = 'nautelle-manual-';
export const manualTmuxSessionSchema = z
  .string()
  .regex(
    /^(?:nautelle|agentdock)-manual-[0-9a-f]{8}$/,
    'must be nautelle-manual-<8 hex>',
  );

export const hookSessionStartedDataSchema = z.strictObject({
  source: hookStartSourceSchema,
  cwd: absolutePath,
  gitBranch: gitBranchSchema.optional(),
  model: name.optional(),
  permissionMode: z.string().min(1).max(32),
  tmuxSession: manualTmuxSessionSchema.optional(),
});

export const hookPromptSubmittedDataSchema = z.strictObject({
  /** Length of the prompt as typed, sent even without content. */
  chars: z.number().int().nonnegative(),
  content: hookContentSchema.optional(),
});

export const hookToolFinishedDataSchema = z.strictObject({
  toolUseId: id,
  toolName: name,
  ok: z.boolean(),
  durationMs: z.number().int().nonnegative().optional(),
  input: hookContentSchema.optional(),
  output: hookContentSchema.optional(),
});

export const hookPermissionRequestedDataSchema = z.strictObject({
  toolName: name,
});

export const hookNotificationDataSchema = z.strictObject({
  /** Claude Code's `notification_type`; the message text is never sent. */
  notificationType: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z_]+$/),
});

/** #390: background tasks one stop reports, at most. */
export const HOOK_BACKGROUND_TASKS_MAX = 1000;

export const hookStoppedDataSchema = z.strictObject({
  /** `last_assistant_message`, only with content. */
  response: hookContentSchema.optional(),
  /**
   * #390: the session's background tasks still running when the turn
   * stopped, as the runner read them from the transcript. Absent from a
   * runner that does not read them.
   */
  backgroundTasks: z
    .number()
    .int()
    .nonnegative()
    .max(HOOK_BACKGROUND_TASKS_MAX)
    .optional(),
  /** #390: the newest running background command, shortened; only with content. */
  background: hookContentSchema.optional(),
});

/** Claude Code's `PreCompact.trigger`: `/compact`, or the context window. */
export const hookCompactTriggerSchema = z.enum(['manual', 'auto']);

/** `custom_instructions` is what a person typed after `/compact`: never sent. */
export const hookPreCompactDataSchema = z.strictObject({
  trigger: hookCompactTriggerSchema,
});

/** Claude Code's `SessionEnd.reason`; unknown reasons arrive as `other`. */
export const hookEndReasonSchema = z.enum([
  'clear',
  'resume',
  'logout',
  'prompt_input_exit',
  'other',
]);

export const hookSessionEndedDataSchema = z.strictObject({
  reason: hookEndReasonSchema,
});

export const hookEventDataSchemas = {
  [HOOK_SESSION_STARTED_EVENT]: hookSessionStartedDataSchema,
  [HOOK_PROMPT_SUBMITTED_EVENT]: hookPromptSubmittedDataSchema,
  [HOOK_TOOL_FINISHED_EVENT]: hookToolFinishedDataSchema,
  [HOOK_PERMISSION_REQUESTED_EVENT]: hookPermissionRequestedDataSchema,
  [HOOK_NOTIFICATION_EVENT]: hookNotificationDataSchema,
  [HOOK_STOPPED_EVENT]: hookStoppedDataSchema,
  [HOOK_PRE_COMPACT_EVENT]: hookPreCompactDataSchema,
  [HOOK_SESSION_ENDED_EVENT]: hookSessionEndedDataSchema,
} as const satisfies Record<HookEventType, z.ZodType>;

export type HookSessionStartedData = z.infer<
  typeof hookSessionStartedDataSchema
>;
export type HookPromptSubmittedData = z.infer<
  typeof hookPromptSubmittedDataSchema
>;
export type HookToolFinishedData = z.infer<typeof hookToolFinishedDataSchema>;
export type HookPermissionRequestedData = z.infer<
  typeof hookPermissionRequestedDataSchema
>;
export type HookNotificationData = z.infer<typeof hookNotificationDataSchema>;
export type HookStoppedData = z.infer<typeof hookStoppedDataSchema>;
export type HookPreCompactData = z.infer<typeof hookPreCompactDataSchema>;
export type HookSessionEndedData = z.infer<typeof hookSessionEndedDataSchema>;

interface HookEventBase {
  ts: string;
  session: { runtime: string; id: string };
  project?: { repo: string; root: string };
}

/** A hook event with its `data` validated, discriminated by `type`. */
export type HookEvent = HookEventBase &
  (
    | { type: typeof HOOK_SESSION_STARTED_EVENT; data: HookSessionStartedData }
    | {
        type: typeof HOOK_PROMPT_SUBMITTED_EVENT;
        data: HookPromptSubmittedData;
      }
    | { type: typeof HOOK_TOOL_FINISHED_EVENT; data: HookToolFinishedData }
    | {
        type: typeof HOOK_PERMISSION_REQUESTED_EVENT;
        data: HookPermissionRequestedData;
      }
    | { type: typeof HOOK_NOTIFICATION_EVENT; data: HookNotificationData }
    | { type: typeof HOOK_STOPPED_EVENT; data: HookStoppedData }
    | { type: typeof HOOK_PRE_COMPACT_EVENT; data: HookPreCompactData }
    | { type: typeof HOOK_SESSION_ENDED_EVENT; data: HookSessionEndedData }
  );

export const isHookEventType = (type: string): type is HookEventType =>
  (HOOK_EVENT_TYPES as readonly string[]).includes(type);

export type ParsedHookEvent =
  | { ok: true; event: HookEvent }
  | { ok: false; error: string };

/**
 * Validates a wire event as a hook event. `null` when its type is not a hook
 * type; an error when it is one but its source, envelope or `data` is wrong.
 */
export const parseHookEvent = (event: RunnerEvent): ParsedHookEvent | null => {
  if (!isHookEventType(event.type)) return null;
  if (event.source !== 'hook') {
    return { ok: false, error: `${event.type} with source ${event.source}` };
  }
  if (!event.session) {
    return { ok: false, error: `${event.type} without an envelope session` };
  }
  const data = hookEventDataSchemas[event.type].safeParse(event.data);
  if (!data.success) {
    return { ok: false, error: z.prettifyError(data.error) };
  }
  return {
    ok: true,
    event: {
      type: event.type,
      ts: event.ts,
      session: { runtime: event.session.runtime, id: event.session.id },
      ...(event.project
        ? { project: { repo: event.project.repo, root: event.project.root } }
        : {}),
      data: data.data,
    } as HookEvent,
  };
};

/** Whether an event carries any content field (ADR-0021 gate, checked by ingest). */
export const hookEventHasContent = (event: HookEvent): boolean => {
  const data = event.data as Record<string, unknown>;
  return ['content', 'input', 'output', 'response', 'background'].some(
    (key) => data[key] !== undefined,
  );
};
