import { z } from 'zod';
import { capabilitiesSchema, hostSchema } from './capabilities';
import { approvalCommands } from './commands/approvals';
import { controlCommands } from './commands/control';
import { queueCommands } from './commands/queue';
import { terminalCommands } from './commands/terminal';
import {
  SESSION_BACKFILL_TIMEOUT_MS,
  sessionBackfillArgsSchema,
  sessionBackfillResultSchema,
} from './events/sessions';
import {
  PROJECT_INSPECTION_TIMEOUT_MS,
  projectInspectArgsSchema,
  projectInspectionSchema,
  projectRefreshArgsSchema,
} from './projects';

/** Roles as plain strings, so this package does not depend on the auth module. */
export const roleSchema = z.enum(['admin', 'operator', 'viewer']);
export type Role = z.infer<typeof roleSchema>;

const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

/** Whether `role` may run a command whose minimum role is `minRole`. */
export const roleAtLeast = (role: Role, minRole: Role): boolean =>
  ROLE_RANK[role] >= ROLE_RANK[minRole];

/** Applied to a command when its definition sets no `timeoutMs`. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export const commandErrorCodeSchema = z.enum([
  /** The name is not in this allowlist. */
  'unknown_command',
  /** The runner's config lists the command in `disabledCommands`. */
  'disabled',
  /** The args failed the command's schema. */
  'invalid_args',
  /** The handler did not finish within the command's timeout. */
  'timeout',
  /** The handler threw; `message` carries no stack trace. */
  'internal',
  /** A path argument does not exist, or is not a directory. */
  'path_not_found',
  /** A path argument is outside what the command may touch (D10). */
  'path_not_allowed',
  /** A path argument is not inside a git repository. */
  'not_a_repository',
  /** The tmux session the command would create already exists (spec 17 D2). */
  'already_running',
  /** The profile's runtime cannot run this command (a `codex` orchestrator). */
  'unsupported_runtime',
  /** `profileId` names no profile in the runner config. */
  'unknown_profile',
  /**
   * The target the runner would resolve does not exist, or is not in that
   * project: a terminal target (spec 29 D2), a skill or a run (spec 24).
   */
  'not_found',
  /** A limit is reached: attaches per runner, or a `write` attach already holds the target (spec 29 D7). */
  'busy',
  /** This machine cannot run the command: no PTY API, not POSIX, or tmux too old (spec 29 D3). */
  'unsupported',
  /** The target already exists: an install branch or directory (spec 24 D3/D4). */
  'already_exists',
  /** The skill's content no longer matches the inspected `contentHash` (spec 24 D3). */
  'changed_since_preview',
  /** The skill is refused as a run: the orchestrator or a worker (spec 24 D8). */
  'not_runnable',
  /** A skill is over `SKILL_MAX_FILES` or `SKILL_MAX_TOTAL_BYTES` (spec 24). */
  'too_large',
  /** The catalog or the forge did not answer (spec 24 D1/D2). */
  'upstream_unavailable',
]);
export type CommandErrorCode = z.infer<typeof commandErrorCodeSchema>;

export interface CommandDefinition<
  Args extends z.ZodType = z.ZodType,
  Result extends z.ZodType = z.ZodType,
> {
  args: Args;
  result: Result;
  minRole: Role;
  timeoutMs?: number;
}

const noArgs = z.strictObject({});

/**
 * The command allowlist (ADR-0010). The runner executes nothing that is not
 * here; each later item adds its command to this object and its handler to
 * the runner in the same change.
 */
export const commands = {
  'runner.ping': {
    args: noArgs,
    result: z.object({ pong: z.literal(true), ts: z.iso.datetime() }),
    minRole: 'viewer',
  },
  'runner.describe': {
    args: noArgs,
    result: hostSchema.extend({
      runnerVersion: z.string().min(1),
      capabilities: capabilitiesSchema,
    }),
    minRole: 'viewer',
  },
  'project.inspect': {
    args: projectInspectArgsSchema,
    result: projectInspectionSchema,
    minRole: 'admin',
    timeoutMs: PROJECT_INSPECTION_TIMEOUT_MS,
  },
  'project.refresh': {
    args: projectRefreshArgsSchema,
    result: projectInspectionSchema,
    minRole: 'operator',
    timeoutMs: PROJECT_INSPECTION_TIMEOUT_MS,
  },
  'session.backfill': {
    args: sessionBackfillArgsSchema,
    result: sessionBackfillResultSchema,
    minRole: 'admin',
    timeoutMs: SESSION_BACKFILL_TIMEOUT_MS,
  },
  ...controlCommands,
  ...approvalCommands,
  ...queueCommands,
  ...terminalCommands,
} as const satisfies Record<string, CommandDefinition>;

export type CommandName = keyof typeof commands;
export type CommandArgs<N extends CommandName> = z.infer<
  (typeof commands)[N]['args']
>;
export type CommandResult<N extends CommandName> = z.infer<
  (typeof commands)[N]['result']
>;

export const commandNames = Object.keys(commands) as CommandName[];

export const isCommandName = (name: string): name is CommandName =>
  Object.hasOwn(commands, name);

export type ParsedCommand =
  | { ok: true; name: CommandName; args: unknown }
  | {
      ok: false;
      error: { code: 'unknown_command' | 'invalid_args'; message: string };
    };

/** Resolves a wire `command` against the allowlist and validates its args. */
export const parseCommand = (name: string, args: unknown): ParsedCommand => {
  if (!isCommandName(name)) {
    return {
      ok: false,
      error: { code: 'unknown_command', message: `unknown command: ${name}` },
    };
  }
  const parsed = commands[name].args.safeParse(args);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'invalid_args',
        message: z.prettifyError(parsed.error),
      },
    };
  }
  return { ok: true, name, args: parsed.data };
};
