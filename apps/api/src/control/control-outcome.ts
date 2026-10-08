import type { CommandRunStatus } from '@agentdock/shared';
import type { CommandErrorCode } from '@agentdock/shared/protocol';
import { ControlFailure } from './control-error';

/** `RunnerCommandService.send`'s result, read structurally. */
export type SendResult<T> =
  | { status: 'ok'; output: T }
  | { status: 'error'; error: { code: CommandErrorCode; message?: string } }
  | { status: 'unknown' };

/** How a sent command ends: the run's final status, and the failure if any. */
export type ControlOutcome<T> =
  | { status: 'ok'; output: T }
  | {
      status: Exclude<CommandRunStatus, 'ok' | 'requested'>;
      failure: ControlFailure;
    };

/**
 * Maps a runner's answer the way `ProjectInspector` does (runner-protocol.md
 * "Error codes"), plus the control codes of spec 17: no answer in time is 504
 * and leaves the run `unknown`; `already_running` 409; a profile the runner
 * cannot use 422; a root or worktree outside the project 403; anything else 502.
 */
export const controlOutcome = <T>(
  name: string,
  result: SendResult<T>,
): ControlOutcome<T> => {
  switch (result.status) {
    case 'ok':
      return { status: 'ok', output: result.output };
    case 'unknown':
      return {
        status: 'unknown',
        failure: new ControlFailure(
          504,
          'runner_timeout',
          `The runner did not answer ${name} in time`,
        ),
      };
    case 'error': {
      const { code, message } = result.error;
      const detail = message ?? code;
      const failure = (statusCode: number, mapped: ControlFailure['code']) => ({
        status: 'error' as const,
        failure: new ControlFailure(statusCode, mapped, detail),
      });
      switch (code) {
        case 'already_running':
          return failure(409, 'already_running');
        case 'unknown_profile':
          return failure(422, 'unknown_profile');
        case 'unsupported_runtime':
          return failure(422, 'unsupported_runtime');
        case 'path_not_allowed':
          return failure(403, 'path_not_allowed');
        case 'timeout':
          // The runner answered: its handler gave up. The outcome is known.
          return failure(504, 'runner_timeout');
        default:
          return {
            status: 'error',
            failure: new ControlFailure(
              502,
              'runner_error',
              `${name}: ${code}${message ? ` — ${message}` : ''}`,
            ),
          };
      }
    }
  }
};
