import { PLANNER_ERROR } from '@agentdock/shared';
import {
  type CommandErrorCode,
  type IssueCreateArgs,
  type IssueCreateResult,
  isCommandName,
  type PlannerCommandName,
  plannerCommands,
} from '@agentdock/shared/protocol';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import {
  RunnerCommandService,
  type SendOptions,
} from '../runners/runner-command.service';
import { RunnerPresence } from '../runners/runner-presence';
import { PlannerFailure } from './planner-error';

export type PlannerCommandArgs<N extends PlannerCommandName> = z.input<
  (typeof plannerCommands)[N]['args']
>;
export type PlannerCommandOutput<N extends PlannerCommandName> = z.infer<
  (typeof plannerCommands)[N]['result']
>;

/** How a command ended — `RunnerCommandService.send`'s shape. */
export type PlannerSendResult<T> =
  | { status: 'ok'; output: T }
  | { status: 'error'; error: { code: CommandErrorCode; message?: string } }
  | { status: 'unknown' };

/**
 * The one place the planner sends runner commands (spec 172 "Protocol").
 *
 * `plannerCommands` is defined in the protocol but entered in the `commands`
 * allowlist only with the runner's handlers (i172-runner). Until then a plan
 * command answers 503 `command_unavailable`, sending nothing; once the
 * allowlist holds it, it goes through `RunnerCommandService` — role check,
 * `runner.command` audit, timeout — with no change here. `issue.create` (#19)
 * is already in the allowlist.
 */
@Injectable()
export class PlannerCommands {
  constructor(
    private readonly commands: RunnerCommandService,
    private readonly presence: RunnerPresence,
  ) {}

  /** Throws 503 `command_unavailable` when `name` cannot be sent to `runnerId` now. */
  assertReady(
    runnerId: string,
    name: PlannerCommandName | 'issue.create',
  ): void {
    const wired: string = name;
    if (!isCommandName(wired)) {
      throw new PlannerFailure(
        503,
        PLANNER_ERROR.commandUnavailable,
        `${name} is not available on the runner yet`,
      );
    }
    if (!this.presence.isConnected(runnerId)) {
      throw new PlannerFailure(
        503,
        PLANNER_ERROR.commandUnavailable,
        'The runner is not connected',
      );
    }
  }

  async send<N extends PlannerCommandName>(
    runnerId: string,
    name: N,
    args: PlannerCommandArgs<N>,
    options: SendOptions,
  ): Promise<PlannerSendResult<PlannerCommandOutput<N>>> {
    this.assertReady(runnerId, name);
    const wired: string = name;
    if (!isCommandName(wired)) throw new Error('unreachable');
    const result = await this.commands.send(runnerId, wired, args, options);
    if (result.status !== 'ok') return result;
    const output = plannerCommands[name].result.safeParse(result.output);
    if (!output.success) {
      return {
        status: 'error',
        error: { code: 'internal', message: 'malformed result' },
      };
    }
    return { status: 'ok', output: output.data as PlannerCommandOutput<N> };
  }

  async createIssue(
    runnerId: string,
    args: IssueCreateArgs,
    options: SendOptions,
  ): Promise<PlannerSendResult<IssueCreateResult>> {
    this.assertReady(runnerId, 'issue.create');
    return this.commands.send(runnerId, 'issue.create', args, options);
  }
}

const MAPPED: Partial<
  Record<CommandErrorCode, { status: number; code: PlannerFailure['code'] }>
> = {
  invalid_args: { status: 400, code: PLANNER_ERROR.invalidArgs },
  not_found: { status: 404, code: PLANNER_ERROR.notFound },
  unsupported_runtime: {
    status: 422,
    code: PLANNER_ERROR.unsupportedRuntime,
  },
  unknown_profile: { status: 422, code: PLANNER_ERROR.unknownProfile },
  timeout: { status: 504, code: PLANNER_ERROR.runnerTimeout },
};

/** The failure a runner error code maps to (runner-protocol.md "Error codes"). */
export const plannerFailureOf = (
  name: string,
  error: { code: CommandErrorCode; message?: string },
): PlannerFailure => {
  const mapped = MAPPED[error.code];
  if (mapped) {
    return new PlannerFailure(
      mapped.status,
      mapped.code,
      error.message ?? error.code,
    );
  }
  return new PlannerFailure(
    502,
    PLANNER_ERROR.commandFailed,
    `${name} failed on the runner: ${error.code}${error.message ? ` — ${error.message}` : ''}`,
  );
};

/**
 * The output of a sent command, or the failure that says why there is none:
 * no answer is 504 `runner_timeout` — the runner may still have done it.
 */
export const plannerOutput = <T>(
  name: string,
  result: PlannerSendResult<T>,
): T => {
  switch (result.status) {
    case 'ok':
      return result.output;
    case 'unknown':
      throw new PlannerFailure(
        504,
        PLANNER_ERROR.runnerTimeout,
        `The runner did not answer ${name} in time`,
      );
    case 'error':
      throw plannerFailureOf(name, result.error);
  }
};
