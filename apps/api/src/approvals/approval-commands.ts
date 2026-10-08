import { APPROVALS_ERROR } from '@agentdock/shared';
import type {
  ApprovalSignalResult,
  CommandErrorCode,
  PrApproveArgs,
  PrInspectArgs,
  PrInspection,
  PrRequestChangesArgs,
  PrVoidApprovalArgs,
  Role,
} from '@agentdock/shared/protocol';
import { Injectable } from '@nestjs/common';
import type { AuditContext } from '../audit/audit.types';
import { approvalsError } from './approvals-error';

export interface ApprovalCommandOptions {
  /** The caller's effective project role; the system sends as `operator`. */
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
      throw approvalsError(
        503,
        APPROVALS_ERROR.commandUnavailable,
        `The runner did not answer ${name}`,
      );
    case 'error':
      throw approvalsError(
        502,
        APPROVALS_ERROR.commandFailed,
        `${name} failed on the runner: ${result.error.message ?? result.error.code}`,
      );
  }
};

const notWired = (name: string) =>
  approvalsError(
    503,
    APPROVALS_ERROR.commandUnavailable,
    `${name} is not available on the runner yet`,
  );

/**
 * The one place the approvals module sends runner commands (spec 20 notes).
 *
 * `pr.inspect`, `pr.approve`, `pr.requestChanges` and `pr.voidApproval` are
 * defined in `packages/shared/src/protocol/commands/approvals.ts` but not yet
 * entered in the `commands` allowlist: the runner's `CommandHandlers` needs a
 * handler for every entry, and the handlers come with the runner slot of #20.
 * Until then each answers 503 `command_unavailable`. That slot spreads
 * `approvalCommands` into `commands` and replaces each body with
 * `commandOutput(name, await this.commands.send(runnerId, name, args, options))`
 * on an injected `RunnerCommandService`.
 */
@Injectable()
export class ApprovalCommands {
  async inspect(
    _runnerId: string,
    _args: PrInspectArgs,
    _options: ApprovalCommandOptions,
  ): Promise<PrInspection> {
    throw notWired('pr.inspect');
  }

  async approve(
    _runnerId: string,
    _args: PrApproveArgs,
    _options: ApprovalCommandOptions,
  ): Promise<ApprovalSignalResult> {
    throw notWired('pr.approve');
  }

  async requestChanges(
    _runnerId: string,
    _args: PrRequestChangesArgs,
    _options: ApprovalCommandOptions,
  ): Promise<ApprovalSignalResult> {
    throw notWired('pr.requestChanges');
  }

  async voidApproval(
    _runnerId: string,
    _args: PrVoidApprovalArgs,
    _options: ApprovalCommandOptions,
  ): Promise<ApprovalSignalResult> {
    throw notWired('pr.voidApproval');
  }
}
