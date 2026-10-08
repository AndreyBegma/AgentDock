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

const notWired = (name: string) =>
  queueError(
    503,
    QUEUE_ERROR.commandUnavailable,
    `${name} is not available on the runner yet`,
  );

/**
 * The one place the queue sends runner commands (spec 19 notes, Q1).
 *
 * `issue.create` and `issues.refresh` are defined in
 * `packages/shared/src/protocol/commands/queue.ts` but not yet entered in the
 * `commands` allowlist: the runner's `CommandHandlers` needs a handler for
 * every entry, and the handlers come with the runner slot of #19. Until then
 * both answer 503 `command_unavailable`. That slot adds the entries and
 * replaces each body with
 * `commandOutput(name, await this.commands.send(runnerId, name, args, options))`
 * on an injected `RunnerCommandService`.
 */
@Injectable()
export class QueueCommands {
  async createIssue(
    _runnerId: string,
    _args: IssueCreateArgs,
    _options: QueueCommandOptions,
  ): Promise<IssueCreateResult> {
    throw notWired('issue.create');
  }

  async refreshIssues(
    _runnerId: string,
    _args: { projectId: string },
    _options: QueueCommandOptions,
  ): Promise<IssuesRefreshResult> {
    throw notWired('issues.refresh');
  }
}
