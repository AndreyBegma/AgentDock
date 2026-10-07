import {
  type CommandArgs,
  type CommandDefinition,
  type CommandErrorCode,
  type CommandMessage,
  type CommandName,
  type CommandResult,
  type CommandResultMessage,
  commands,
  DEFAULT_COMMAND_TIMEOUT_MS,
  isCommandName,
  parseCommand,
} from '@agentdock/shared/protocol';
import type { Clock } from '../clock';
import { errorMessage, type Logger } from '../log';

/** One handler per allowlisted command; the compiler refuses a missing one. */
export type CommandHandlers = {
  [N in CommandName]: (
    args: CommandArgs<N>,
  ) => Promise<CommandResult<N>> | CommandResult<N>;
};

export interface DispatcherOptions {
  handlers: CommandHandlers;
  disabledCommands: readonly string[];
  clock: Clock;
  log: Logger;
}

export type Dispatch = (
  message: CommandMessage,
) => Promise<CommandResultMessage>;

const failure = (
  id: string,
  code: CommandErrorCode,
  message: string,
): CommandResultMessage => ({
  type: 'command.result',
  id,
  ok: false,
  error: { code, message },
});

class CommandTimeout extends Error {}

/**
 * Typed command dispatch (ADR-0010, D8). Order: unknown → disabled →
 * invalid args → handler under a timeout → result checked against its schema.
 * Every outcome is a `command.result`; nothing here throws.
 */
export const createDispatcher = (options: DispatcherOptions): Dispatch => {
  const { handlers, clock, log } = options;
  const disabled = new Set(options.disabledCommands);

  const invoke = <N extends CommandName>(name: N, args: unknown) =>
    // `args` was validated by `parseCommand` against `commands[name].args`.
    handlers[name](args as CommandArgs<N>);

  const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> => {
    let cancel = () => {};
    const timeout = new Promise<never>((_, reject) => {
      cancel = clock.setTimeout(() => reject(new CommandTimeout()), ms);
    });
    return Promise.race([work, timeout]).finally(cancel);
  };

  return async (message) => {
    const { id, name } = message;
    if (!isCommandName(name)) {
      log.warn('command: unknown', { id, name });
      return failure(id, 'unknown_command', `unknown command: ${name}`);
    }
    if (disabled.has(name)) {
      log.warn('command: disabled', { id, name });
      return failure(
        id,
        'disabled',
        `command disabled on this runner: ${name}`,
      );
    }
    const parsed = parseCommand(name, message.args);
    if (!parsed.ok) {
      log.warn('command: rejected', { id, name, code: parsed.error.code });
      return failure(id, parsed.error.code, parsed.error.message);
    }

    const definition: CommandDefinition = commands[name];
    const timeoutMs = definition.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    let output: unknown;
    try {
      output = await withTimeout(
        Promise.resolve().then(() => invoke(name, parsed.args)),
        timeoutMs,
      );
    } catch (error) {
      if (error instanceof CommandTimeout) {
        log.warn('command: timed out', { id, name, timeoutMs });
        return failure(
          id,
          'timeout',
          `${name} did not finish within ${timeoutMs} ms`,
        );
      }
      log.error('command: handler failed', {
        id,
        name,
        error: errorMessage(error),
      });
      return failure(id, 'internal', errorMessage(error));
    }

    const result = definition.result.safeParse(output);
    if (!result.success) {
      log.error('command: handler returned an invalid result', { id, name });
      return failure(id, 'internal', `${name} returned an invalid result`);
    }
    log.debug('command: done', { id, name });
    return { type: 'command.result', id, ok: true, output: result.data };
  };
};
