import { z } from 'zod';
import type { CommandDefinition } from '../commands';
import { absolutePathSchema } from '../projects';
import {
  terminalColsSchema,
  terminalIdSchema,
  terminalModeSchema,
  terminalRowsSchema,
} from '../terminal';
import { slotNameSchema } from './control';

/**
 * `terminal.attach` (docs/specs/29-terminal-attach.md). Defined and exported
 * here, but entered in the `commands` allowlist only together with its runner
 * handler: the runner's `CommandHandlers` needs a handler for every key of
 * that map, so an entry without one breaks the runner build (spec 29, notes).
 */

/** Resolving the target and spawning the PTY; the stream itself outlives the command. */
export const TERMINAL_ATTACH_TIMEOUT_MS = 10_000;

/** A run id as #21/#24 key it; it lands in `runs/<runId>/`, so it is a plain token. */
export const terminalRunIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'must match ^[A-Za-z0-9_-]{1,64}$');

const projectTarget = {
  projectId: z.string().min(1),
  root: absolutePathSchema,
};

/**
 * What to attach to (D2). The runner resolves the tmux session name itself:
 * `slot` → `cs-<slot>` when the slot's worktree belongs to `root`,
 * `orchestrator` → the project's orchestrator session, `skill_run` →
 * `agentdock-run-<shortid>` of a live run of that project. There is no field
 * for a session name or a command, and an unknown field fails to parse.
 */
export const terminalTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('slot'),
    ...projectTarget,
    slot: slotNameSchema,
  }),
  z.strictObject({ kind: z.literal('orchestrator'), ...projectTarget }),
  z.strictObject({
    kind: z.literal('skill_run'),
    ...projectTarget,
    runId: terminalRunIdSchema,
  }),
]);
export type TerminalTarget = z.infer<typeof terminalTargetSchema>;
export type TerminalTargetKind = TerminalTarget['kind'];

/**
 * `id` is the stream id the server chose for this attach: every
 * `terminal.data`, `terminal.resize` and `terminal.close` of it carries the
 * same `id`. It is distinct from the `command` message id.
 */
export const terminalAttachArgsSchema = z.strictObject({
  id: terminalIdSchema,
  target: terminalTargetSchema,
  mode: terminalModeSchema,
  cols: terminalColsSchema,
  rows: terminalRowsSchema,
});
export type TerminalAttachArgs = z.infer<typeof terminalAttachArgsSchema>;

/** The resolved session, for the audit record; errors are `not_found`, `busy`, `unsupported`, `disabled`. */
export const terminalAttachResultSchema = z.strictObject({
  attached: z.literal(true),
  session: z.string().min(1).max(256),
});
export type TerminalAttachResult = z.infer<typeof terminalAttachResultSchema>;

export const terminalCommands = {
  'terminal.attach': {
    args: terminalAttachArgsSchema,
    result: terminalAttachResultSchema,
    minRole: 'admin',
    timeoutMs: TERMINAL_ATTACH_TIMEOUT_MS,
  },
} as const satisfies Record<string, CommandDefinition>;
