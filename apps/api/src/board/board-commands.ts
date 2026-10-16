import { BOARD_ERROR } from '@agentdock/shared';
import {
  type CardChecksArgs,
  type CardChecksResult,
  type CardCommandName,
  type CardPrCloseArgs,
  type CardPrCloseResult,
  type CommandErrorCode,
  cardChecksResultSchema,
  cardCommands,
  cardPrCloseResultSchema,
  type IssueCreateArgs,
  type IssueCreateResult,
  isCommandName,
  type PlanCloseArgs,
  type PlanCloseResult,
  type PrInspectArgs,
  type PrInspection,
  planCloseResultSchema,
  prInspectionSchema,
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
  assertReady(
    runnerId: string,
    name:
      | CardCommandName
      | 'card.checks'
      | 'card.prClose'
      | 'issue.create'
      | 'plan.close'
      | 'pr.inspect',
  ): void {
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

  /** Whether `name` can be sent to `runnerId` now — `assertReady` without the throw. */
  serves(runnerId: string, name: CardCommandName): boolean {
    try {
      this.assertReady(runnerId, name);
      return true;
    } catch (error) {
      if (error instanceof BoardFailure) return false;
      throw error;
    }
  }

  /**
   * #329 D7–D9: whether the connected runner advertises `card.prClose`. Its
   * release also takes `card.merge`'s `deleteBranch`; a runner that
   * advertised nothing (`unknown`) is older than both.
   */
  advertisesPrClose(runnerId: string): boolean {
    const wired: string = 'card.prClose';
    if (!isCommandName(wired)) return false;
    const support = this.presence.commandSupport(runnerId, wired);
    return support === 'supported' || support === 'disabled';
  }

  /**
   * #359: whether a card ships itself on `runnerId` — the runner advertises
   * `card.checks`, whose release also takes `card.run`'s `pullRequest` and
   * `newBranch` and reports `card_run.pushed`. Until the runner enters it in
   * the `commands` allowlist, no card ships itself and the board works as
   * before #359.
   */
  servesChecks(runnerId: string): boolean {
    const wired: string = 'card.checks';
    if (!isCommandName(wired) || !this.presence.isConnected(runnerId)) {
      return false;
    }
    const support = this.presence.commandSupport(runnerId, wired);
    return support === 'supported' || support === 'disabled';
  }

  /** #359 D5: a card PR's head, merge state and checks, read by the runner's `gh`. */
  async checks(
    runnerId: string,
    args: CardChecksArgs,
    options: SendOptions,
  ): Promise<BoardSendResult<CardChecksResult>> {
    this.assertReady(runnerId, 'card.checks');
    const wired: string = 'card.checks';
    if (!isCommandName(wired)) throw new Error('unreachable');
    const result = await this.commands.send(runnerId, wired, args, options);
    if (result.status !== 'ok') return result;
    const output = cardChecksResultSchema.safeParse(result.output);
    return output.success
      ? { status: 'ok', output: output.data }
      : {
          status: 'error',
          error: { code: 'internal', message: 'malformed result' },
        };
  }

  /**
   * #329 D8: `card.prClose`. Until i329-runner enters it in the `commands`
   * allowlist, `assertReady` answers 503 `command_unavailable` and nothing
   * is sent.
   */
  async closePr(
    runnerId: string,
    args: CardPrCloseArgs,
    options: SendOptions,
  ): Promise<BoardSendResult<CardPrCloseResult>> {
    this.assertReady(runnerId, 'card.prClose');
    const wired: string = 'card.prClose';
    if (!isCommandName(wired)) throw new Error('unreachable');
    const result = await this.commands.send(runnerId, wired, args, options);
    if (result.status !== 'ok') return result;
    const output = cardPrCloseResultSchema.safeParse(result.output);
    return output.success
      ? { status: 'ok', output: output.data }
      : {
          status: 'error',
          error: { code: 'internal', message: 'malformed result' },
        };
  }

  /** #273 D10: the card's PR as `gh pr view` reads it on the runner. */
  async inspectPr(
    runnerId: string,
    args: PrInspectArgs,
    options: SendOptions,
  ): Promise<BoardSendResult<PrInspection>> {
    this.assertReady(runnerId, 'pr.inspect');
    const result = await this.commands.send(
      runnerId,
      'pr.inspect',
      args,
      options,
    );
    if (result.status !== 'ok') return result;
    const output = prInspectionSchema.safeParse(result.output);
    return output.success
      ? { status: 'ok', output: output.data }
      : {
          status: 'error',
          error: { code: 'internal', message: 'malformed result' },
        };
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

  /**
   * #243 D2: a card's design turns run as `plan.turn` with `planId =
   * card.id`; deleting the card closes that plan on the runner.
   */
  async closeDesign(
    runnerId: string,
    args: PlanCloseArgs,
    options: SendOptions,
  ): Promise<BoardSendResult<PlanCloseResult>> {
    this.assertReady(runnerId, 'plan.close');
    const result = await this.commands.send(
      runnerId,
      'plan.close',
      args,
      options,
    );
    if (result.status !== 'ok') return result;
    const output = planCloseResultSchema.safeParse(result.output);
    return output.success
      ? { status: 'ok', output: output.data }
      : {
          status: 'error',
          error: { code: 'internal', message: 'malformed result' },
        };
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
    // #309 D9: the runner could not download or verify an attachment.
    case 'attachments_unavailable':
      return new BoardFailure(
        502,
        BOARD_ERROR.attachmentsUnavailable,
        `${name}: the attachments could not be delivered to the runner${detail}`,
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
