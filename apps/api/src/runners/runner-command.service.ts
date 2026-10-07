import { randomUUID } from 'node:crypto';
import { RUNNER_ERROR } from '@agentdock/shared';
import {
  type CommandErrorCode,
  type CommandName,
  type CommandResult,
  commands,
  DEFAULT_COMMAND_TIMEOUT_MS,
  parseCommand,
  type Role,
  roleAtLeast,
} from '@agentdock/shared/protocol';
import { Injectable, Logger } from '@nestjs/common';
import { type CommandOutcome, RunnerConnections } from './runner-connections';
import { runnerError } from './runner-error';

export interface SendOptions {
  /** The caller's role, checked against the command's minimum role. */
  role: Role;
  /** Defaults to the command's own timeout, else 30 s. */
  timeoutMs?: number;
}

/**
 * How a command ended. `unknown`: no result within the timeout, the socket
 * closed first, or the runner is offline — nothing retries it (at-most-once).
 */
export type CommandSendResult<N extends CommandName> =
  | { status: 'ok'; output: CommandResult<N>; rttMs: number }
  | { status: 'error'; error: { code: CommandErrorCode; message?: string } }
  | { status: 'unknown' };

/** Sends typed commands to runners and awaits their results (spec D8). */
@Injectable()
export class RunnerCommandService {
  private readonly logger = new Logger(RunnerCommandService.name);

  constructor(private readonly connections: RunnerConnections) {}

  async send<N extends CommandName>(
    runnerId: string,
    name: N,
    args: unknown,
    options: SendOptions,
  ): Promise<CommandSendResult<N>> {
    const parsed = parseCommand(name, args);
    if (!parsed.ok) {
      throw runnerError(400, RUNNER_ERROR.invalidCommand, parsed.error.message);
    }
    const definition = commands[name];
    if (!roleAtLeast(options.role, definition.minRole)) {
      throw runnerError(
        403,
        RUNNER_ERROR.forbidden,
        `${name} needs the ${definition.minRole} role`,
      );
    }

    const connection = this.connections.get(runnerId);
    if (!connection) return { status: 'unknown' };

    const id = `cmd_${randomUUID()}`;
    const timeoutMs =
      options.timeoutMs ??
      ('timeoutMs' in definition && typeof definition.timeoutMs === 'number'
        ? definition.timeoutMs
        : DEFAULT_COMMAND_TIMEOUT_MS);
    const sentAt = performance.now();

    const outcome = await new Promise<CommandOutcome | 'timeout'>(
      (resolve) => {
        const timer = setTimeout(() => {
          connection.forget(id);
          resolve('timeout');
        }, timeoutMs);
        timer.unref();
        connection.expect(id, (o) => {
          clearTimeout(timer);
          resolve(o);
        });
        if (!connection.send({ type: 'command', id, name, args: parsed.args })) {
          connection.forget(id);
          clearTimeout(timer);
          resolve({ kind: 'lost' });
        }
      },
    );
    const rttMs = Math.round(performance.now() - sentAt);

    if (outcome === 'timeout' || outcome.kind === 'lost') {
      this.logger.warn(`${name} on runner ${runnerId}: no result (unknown)`);
      return { status: 'unknown' };
    }
    const { message } = outcome;
    if (!message.ok) {
      // `error` is present exactly when ok is false (commandResultMessageSchema).
      return {
        status: 'error',
        error: message.error ?? { code: 'internal' },
      };
    }
    const output = definition.result.safeParse(message.output);
    if (!output.success) {
      this.logger.warn(`${name} on runner ${runnerId}: malformed result`);
      return {
        status: 'error',
        error: { code: 'internal', message: 'malformed result' },
      };
    }
    return {
      status: 'ok',
      output: output.data as CommandResult<N>,
      rttMs,
    };
  }
}
