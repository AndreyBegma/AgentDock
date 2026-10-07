import type { CommandErrorCode } from '@agentdock/shared/protocol';

/**
 * Thrown by a handler to answer with a specific error code instead of
 * `internal`. `message` is sent to the server as is.
 */
export class CommandFailure extends Error {
  constructor(
    readonly code: Exclude<CommandErrorCode, 'internal' | 'timeout'>,
    message: string,
  ) {
    super(message);
  }
}
