import { BOARD_ERROR } from '@agentdock/shared';
import {
  type CardCommandName,
  type CommandErrorCode,
  cardCommands,
  type IssueCreateArgs,
  type IssueCreateResult,
  isCommandName,
} from '@agentdock/shared/protocol';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import {
  RunnerCommandService,
  type SendOptions,
} from '../runners/runner-command.service';
import { RunnerPresence } from '../runners/runner-presence';
import { BoardFailure } from './board-error';

export type CardCommandArgs<N extends CardCommandName> = z.input<
  (typeof cardCommands)[N]['args']
>;
export type CardCommandOutput<N extends CardCommandName> = z.infer<
  (typeof cardCommands)[N]['result']
>;

/** How a command ended — `RunnerCommandService.send`'s shape. */
export type BoardSendResult<T> =
  | { status: 'ok'; output: T }
  | { status: 'error'; error: { code: CommandErrorCode; message?: string } }
  | { status: 'unknown' };

/**
 * The one place the board sends runner commands (issue #242 "Runner").
 *
 * `cardCommands` is defined in the protocol but entered in the `commands`
 * allowlist only with the runner's handlers (i242-runner). Until then a card
 * command answers 503 `command_unavailable`, sending nothing; once the
 * allowlist holds it, it goes through `RunnerCommandService` — role check,
 * `runner.command` audit, timeout — with no change here. `issue.create` (#19)
 * is already in the allowlist.
 */
@Injectable()
export class BoardCommands {
  constructor(
    private readonly commands: RunnerCommandService,
    private readonly presence: RunnerPresence,
  ) {}

  /** Throws 503 `command_unavailable` when `name` cannot be sent to `runnerId` now. */
  assertReady(runnerId: string, name: CardCommandName | 'issue.create'): void {
    const wired: string = name;
    if (!isCommandName(wired)) {
      throw new BoardFailure(
        503,
        BOARD_ERROR.commandUnavailable,
        `${name} is not available on the runner yet`,
      );
    }
    if (!this.presence.isConnected(runnerId)) {
      throw new BoardFailure(
        503,
        BOARD_ERROR.commandUnavailable,
        'The runner is not connected',
      );
    }
    if (this.presence.missingCommand(runnerId, [wired])) {
      throw new BoardFailure(
        503,
        BOARD_ERROR.commandUnavailable,
        `The runner does not serve ${name}; update it`,
      );
    }
  }

  async send<N extends CardCommandName>(
    runnerId: string,
    name: N,
    args: CardCommandArgs<N>,
    options: SendOptions,
  ): Promise<BoardSendResult<CardCommandOutput<N>>> {
    this.assertReady(runnerId, name);
    const wired: string = name;
    if (!isCommandName(wired)) throw new Error('unreachable');
    const result = await this.commands.send(runnerId, wired, args, options);
    if (result.status !== 'ok') return result;
    const output = cardCommands[name].result.safeParse(result.output);
    if (!output.success) {
      return {
        status: 'error',
        error: { code: 'internal', message: 'malformed result' },
      };
    }
    return { status: 'ok', output: output.data as CardCommandOutput<N> };
  }

  async createIssue(
    runnerId: string,
    args: IssueCreateArgs,
    options: SendOptions,
  ): Promise<BoardSendResult<IssueCreateResult>> {
    this.assertReady(runnerId, 'issue.create');
    return this.commands.send(runnerId, 'issue.create', args, options);
  }
}

/**
 * The output of a sent command, or the failure that says why there is none.
 * The board's error codes are few (`BOARD_ERROR`): a runner that did not
 * answer or failed the command reads as the command being unavailable, with
 * the runner's code in the message.
 */
export const boardOutput = <T>(name: string, result: BoardSendResult<T>): T => {
  switch (result.status) {
    case 'ok':
      return result.output;
    case 'unknown':
      throw new BoardFailure(
        504,
        BOARD_ERROR.commandUnavailable,
        `The runner did not answer ${name} in time`,
      );
    case 'error':
      throw boardFailureOf(name, result.error);
  }
};

export const boardFailureOf = (
  name: string,
  error: { code: CommandErrorCode; message?: string },
): BoardFailure => {
  const detail = error.message ? ` — ${error.message}` : '';
  switch (error.code) {
    case 'not_found':
      return new BoardFailure(
        404,
        BOARD_ERROR.notFound,
        `${name}: not found on the runner${detail}`,
      );
    case 'unsupported_runtime':
    case 'unknown_profile':
      return new BoardFailure(
        422,
        BOARD_ERROR.unsupportedRuntime,
        `${name}: ${error.code}${detail}`,
      );
    default:
      return new BoardFailure(
        502,
        BOARD_ERROR.commandUnavailable,
        `${name} failed on the runner: ${error.code}${detail}`,
      );
  }
};
