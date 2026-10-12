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
import { RunnerCommandService } from '../runners/runner-command.service';
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

/**
 * The one place the approvals module sends runner commands (spec 20 notes).
 * `pr.inspect`, `pr.approve`, `pr.requestChanges` and `pr.voidApproval` are in
 * the `commands` allowlist now that the runner registers their handlers.
 */
@Injectable()
export class ApprovalCommands {
  constructor(private readonly commands: RunnerCommandService) {}

  async inspect(
    runnerId: string,
    args: PrInspectArgs,
    options: ApprovalCommandOptions,
  ): Promise<PrInspection> {
    return commandOutput(
      'pr.inspect',
      await this.commands.send(runnerId, 'pr.inspect', args, options),
    );
  }

  async approve(
    runnerId: string,
    args: PrApproveArgs,
    options: ApprovalCommandOptions,
  ): Promise<ApprovalSignalResult> {
    return commandOutput(
      'pr.approve',
      await this.commands.send(runnerId, 'pr.approve', args, options),
    );
  }

  async requestChanges(
    runnerId: string,
    args: PrRequestChangesArgs,
    options: ApprovalCommandOptions,
  ): Promise<ApprovalSignalResult> {
    return commandOutput(
      'pr.requestChanges',
      await this.commands.send(runnerId, 'pr.requestChanges', args, options),
    );
  }

  async voidApproval(
    runnerId: string,
    args: PrVoidApprovalArgs,
    options: ApprovalCommandOptions,
  ): Promise<ApprovalSignalResult> {
    return commandOutput(
      'pr.voidApproval',
      await this.commands.send(runnerId, 'pr.voidApproval', args, options),
    );
  }
}
