import {
  type BoardErrorBody,
  type BoardErrorCode,
  type CardAutoRunFailure,
  isCardAutoRunCode,
} from '@agentdock/shared';
import { HttpException } from '@nestjs/common';

/**
 * A refusal's details beside its message: `reason`, `no_profile`'s source and
 * key (#272 D2), `dependency_open`'s open dependencies (#337 D8), and
 * `stack_refused`'s cards that cannot join (#588).
 */
type BoardErrorExtra = Pick<
  BoardErrorBody,
  'reason' | 'source' | 'profileKey' | 'dependencies' | 'cards'
>;

/**
 * An HTTP error of the board routes, shaped like every other API error. Its
 * `code` lets a caller audit the refusal before rethrowing it.
 */
export class BoardFailure extends HttpException {
  constructor(
    readonly statusCode: number,
    readonly code: BoardErrorCode,
    message: string,
    extra: BoardErrorExtra = {},
  ) {
    const body: BoardErrorBody = {
      statusCode,
      error: code,
      message,
      ...extra,
    };
    super(body, statusCode);
  }
}

export const boardError = (
  statusCode: number,
  code: BoardErrorCode,
  message: string,
  extra: BoardErrorExtra = {},
): BoardFailure => new BoardFailure(statusCode, code, message, extra);

export const cardNotFound = (): BoardFailure =>
  boardError(404, 'not_found', 'Card not found');

/** #273 D8: `CardAutoRunFailure.message` is at most this many characters. */
const AUTO_RUN_MESSAGE_MAX = 500;

/**
 * #273 D8, #443: why an automatic start was refused — the refusal's `error`
 * when it is a board code (`max_running`, `budget_exceeded`,
 * `command_unavailable`, …), else `unknown`, with its message: what a
 * manual Run in that state is told.
 */
export const autoRunFailureOf = (
  error: unknown,
): { code: CardAutoRunFailure['code']; message: string } => {
  const body = error instanceof HttpException ? error.getResponse() : null;
  const code =
    body !== null &&
    typeof body === 'object' &&
    'error' in body &&
    typeof body.error === 'string' &&
    isCardAutoRunCode(body.error)
      ? body.error
      : 'unknown';
  const message = error instanceof Error ? error.message : String(error);
  return { code, message: message.slice(0, AUTO_RUN_MESSAGE_MAX) };
};
