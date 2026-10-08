import { QUEUE_ERROR } from '@agentdock/shared';
import type {
  CommandErrorCode,
  IssueCreateArgs,
  IssueCreateResult,
  IssuesRefreshResult,
  Role,
} from '@agentdock/shared/protocol';
import { Injectable } from '@nestjs/common';
import type { AuditContext } from '../audit/audit.types';
import { RunnerCommandService } from '../runners/runner-command.service';
import { queueError } from './queue-error';

export interface QueueCommandOptions {
  /** The caller's effective project role. */
  role: Role;
  ctx: AuditContext;
}

/** `RunnerCommandService.send`'s result, read structurally. */
type SendResult<T> =
  | { status: 'ok'; output: T }
  | { status: 'error'; error: { code: CommandErrorCode; message?: string } }
  | { status: 'unknown' };

/**
 * The output of a sent command, or the HTTP error that says why there is none:
 * `unknown` (runner offline, no answer) is 503, a runner error 502.
 */
export const commandOutput = <T>(name: string, result: SendResult<T>): T => {
  switch (result.status) {
    case 'ok':
      return result.output;
    case 'unknown':
      throw queueError(
        503,
        QUEUE_ERROR.commandUnavailable,
        `The runner did not answer ${name}`,
      );
    case 'error':
      throw queueError(
        502,
        QUEUE_ERROR.commandFailed,
        `${name} failed on the runner: ${result.error.message ?? result.error.code}`,
      );
  }
};

/**
 * The one place the queue sends runner commands (spec 19 notes, 1).
 * `issue.create` and `issues.refresh` are in the `commands` allowlist now that
 * the runner registers their handlers.
 */
@Injectable()
export class QueueCommands {
  constructor(private readonly commands: RunnerCommandService) {}

  async createIssue(
    runnerId: string,
    args: IssueCreateArgs,
    options: QueueCommandOptions,
  ): Promise<IssueCreateResult> {
    return commandOutput(
      'issue.create',
      await this.commands.send(runnerId, 'issue.create', args, options),
    );
  }

  async refreshIssues(
    runnerId: string,
    args: { projectId: string },
    options: QueueCommandOptions,
  ): Promise<IssuesRefreshResult> {
    return commandOutput(
      'issues.refresh',
      await this.commands.send(runnerId, 'issues.refresh', args, options),
    );
  }
}
