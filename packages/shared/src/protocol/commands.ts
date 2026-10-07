import { z } from 'zod';
import { capabilitiesSchema, hostSchema } from './capabilities';

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
