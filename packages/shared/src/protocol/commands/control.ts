import { z } from 'zod';
import type { CommandDefinition } from '../commands';
import { absolutePathSchema } from '../projects';

/**
 * Orchestrator and slot control (docs/specs/17-orchestrator-and-slot-control.md).
 *
 * `commands` spreads `controlCommands` into the allowlist. The runner's
 * dispatcher requires a handler for every key there, so the map entry and the
 * runner handlers land together.
 */

/**
 * A slot name as the orchestrator's `dispatch.sh` writes it: lower-case
 * letters, digits and `-`, never leading with `-`. It is interpolated into
 * `tmux -t cs-<slot>` and `.wt-<repo>-<slot>`, so it can carry no `/`, `.`,
 * `:` or flag syntax. The one slot-name rule of the protocol: `slot.*`
 * commands, `subscribe`/`unsubscribe` and `pane` reuse it.
 */
export const SLOT_NAME_MAX_LENGTH = 64;
export const slotNameSchema = z
  .string()
  .max(SLOT_NAME_MAX_LENGTH)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'must match ^[a-z0-9][a-z0-9-]*$');

/** `start` begins a round; `next` resumes from the board (the skill's own verbs). */
export const orchestratorModeSchema = z.enum(['start', 'next']);
export type OrchestratorMode = z.infer<typeof orchestratorModeSchema>;

/**
 * D3. `manual` is the protocol's name for the runtime's default, prompting
 * mode; the runner maps it to the CLI's own value.
 */
export const orchestratorPermissionModeSchema = z.enum([
  'auto',
  'acceptEdits',
  'bypassPermissions',
  'manual',
]);
export type OrchestratorPermissionMode = z.infer<
  typeof orchestratorPermissionModeSchema
>;

/**
 * A model alias or id (`opus`, `claude-opus-5-5`, `opus[1m]`). It goes into
 * argv after `--model`; never leading with `-`, so it cannot read as a flag.
 */
export const orchestratorModelSchema = z
  .string()
  .max(100)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/,
    'must be a model alias or id, not starting with "-"',
  );

/** D3: used when neither the project nor the start request sets a value. */
export const ORCHESTRATOR_DEFAULTS = {
  model: 'opus',
  permissionMode: 'auto',
} as const satisfies {
  model: string;
  permissionMode: OrchestratorPermissionMode;
};

export const ORCHESTRATOR_SESSION_PREFIX = 'agentdock-orch-';

/**
 * D1: the orchestrator's tmux session for a repository `owner/name`. Never a
 * `cs-` prefix — the skill's `watch.sh` treats every `cs-*` session as a slot.
 */
export const orchestratorSessionName = (repo: string): string =>
  ORCHESTRATOR_SESSION_PREFIX + repo.toLowerCase().replace(/[^a-z0-9-]/g, '-');

/** D7: the message file holds at most this many UTF-8 bytes of `text`. */
export const SLOT_MESSAGE_MAX_BYTES = 16 * 1024;

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

/** The #11 pane classification, or `absent` when the session does not exist. */
export const orchestratorStateSchema = z.enum([
  'running',
  'idle',
  'prompt',
  'quota',
  'absent',
]);
export type OrchestratorState = z.infer<typeof orchestratorStateSchema>;

/** D11 timeouts. Start waits for the tmux session, not for the agent to be ready. */
export const CONTROL_TIMEOUTS_MS = {
  start: 30_000,
  stop: 10_000,
  status: 5_000,
  message: 10_000,
} as const;

const projectTarget = {
  projectId: z.string().min(1),
  root: absolutePathSchema,
};

export const orchestratorStartArgsSchema = z.strictObject({
  ...projectTarget,
  /** A profile `id` in the runner config (ADR-0006). */
  profileId: z.string().min(1),
  model: orchestratorModelSchema,
  permissionMode: orchestratorPermissionModeSchema,
  mode: orchestratorModeSchema,
});
export type OrchestratorStartArgs = z.infer<typeof orchestratorStartArgsSchema>;

export const orchestratorStartResultSchema = z.object({
  session: z.string().min(1),
  startedAt: z.iso.datetime(),
});
export type OrchestratorStartResult = z.infer<
  typeof orchestratorStartResultSchema
>;

export const orchestratorTargetArgsSchema = z.strictObject(projectTarget);
export type OrchestratorTargetArgs = z.infer<
  typeof orchestratorTargetArgsSchema
>;

export const stoppedResultSchema = z.object({ stopped: z.boolean() });
export type StoppedResult = z.infer<typeof stoppedResultSchema>;

export const orchestratorStatusResultSchema = z
  .object({
    present: z.boolean(),
    state: orchestratorStateSchema,
    session: z.string().min(1).optional(),
    startedAt: z.iso.datetime().optional(),
  })
  .refine((s) => s.present === (s.state !== 'absent'), {
    message: '`state` is `absent` exactly when `present` is false',
    path: ['state'],
  });
export type OrchestratorStatusResult = z.infer<
  typeof orchestratorStatusResultSchema
>;

export const slotStopArgsSchema = z.strictObject({
  ...projectTarget,
  slot: slotNameSchema,
});
export type SlotStopArgs = z.infer<typeof slotStopArgsSchema>;

export const slotMessageArgsSchema = z.strictObject({
  ...projectTarget,
  slot: slotNameSchema,
  text: z
    .string()
    .min(1)
    .refine((t) => t.trim().length > 0, { message: 'must not be blank' })
    .refine((t) => utf8Bytes(t) <= SLOT_MESSAGE_MAX_BYTES, {
      message: `must be at most ${SLOT_MESSAGE_MAX_BYTES} bytes`,
    }),
  /** The requesting user's email, for the `From:` header (D7). */
  from: z.email(),
});
export type SlotMessageArgs = z.infer<typeof slotMessageArgsSchema>;

/**
 * The message file is always written. `delivered` is true only when the
 * worker's session was live and the two `send-keys` calls ran; otherwise the
 * file waits for the worker to be resumed.
 */
export const slotMessageResultSchema = z.object({
  written: z.literal(true),
  delivered: z.boolean(),
});
export type SlotMessageResult = z.infer<typeof slotMessageResultSchema>;

/** The five control commands, with D9's minimum roles and D11's timeouts. */
export const controlCommands = {
  'orchestrator.start': {
    args: orchestratorStartArgsSchema,
    result: orchestratorStartResultSchema,
    minRole: 'operator',
    timeoutMs: CONTROL_TIMEOUTS_MS.start,
  },
  'orchestrator.stop': {
    args: orchestratorTargetArgsSchema,
    result: stoppedResultSchema,
    minRole: 'operator',
    timeoutMs: CONTROL_TIMEOUTS_MS.stop,
  },
  'orchestrator.status': {
    args: orchestratorTargetArgsSchema,
    result: orchestratorStatusResultSchema,
    minRole: 'viewer',
    timeoutMs: CONTROL_TIMEOUTS_MS.status,
  },
  'slot.stop': {
    args: slotStopArgsSchema,
    result: stoppedResultSchema,
    minRole: 'operator',
    timeoutMs: CONTROL_TIMEOUTS_MS.stop,
  },
  'slot.message': {
    args: slotMessageArgsSchema,
    result: slotMessageResultSchema,
    minRole: 'operator',
    timeoutMs: CONTROL_TIMEOUTS_MS.message,
  },
} as const satisfies Record<string, CommandDefinition>;

export type ControlCommandName = keyof typeof controlCommands;
