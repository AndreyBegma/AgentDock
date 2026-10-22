import { APPROVALS_ERROR, redactSecrets } from '@nautelle/shared';
import type {
  ApprovalSignalResult,
  CommandErrorCode,
  PrApproveArgs,
  PrInspectArgs,
  PrInspection,
  PrRequestChangesArgs,
  PrVoidApprovalArgs,
  Role,
} from '@nautelle/shared/protocol';
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

/** Fixed headlines for the runner error codes a PR command is known to return. */
const HEADLINES: Partial<Record<CommandErrorCode, string>> = {
  timeout: 'The runner did not finish in time',
  not_found: 'The runner could not find the pull request',
  path_not_found: "The project's checkout is missing on the runner",
  not_a_repository:
    "The project's checkout on the runner is not a git repository",
  unknown_command: 'The runner is too old for this command',
  disabled: "The runner's config disables this command",
  policy_refused: "The runner's security policy refused the command",
};

export interface CommandFailure {
  /** Fixed copy for a known code, else the command and the code. */
  headline: string;
  /** The runner's own error text, secrets redacted (WI-74). */
  detail?: string;
}

/**
 * What a runner error says to every reader, viewers included (D-03): the
 * headline, and the runner's text as detail with URL userinfo and token
 * shapes redacted — a failed `git` or `gh` may echo a credential.
 */
export const commandFailure = (
  name: string,
  error: { code: CommandErrorCode; message?: string },
): CommandFailure => {
  const headline =
    HEADLINES[error.code] ?? `${name} failed on the runner: ${error.code}`;
  return error.message
    ? { headline, detail: redactSecrets(error.message) }
    : { headline };
};

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
    case 'error': {
      const { headline, detail } = commandFailure(name, result.error);
      throw approvalsError(
        502,
        APPROVALS_ERROR.commandFailed,
        headline,
        detail === undefined ? {} : { detail },
      );
    }
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
