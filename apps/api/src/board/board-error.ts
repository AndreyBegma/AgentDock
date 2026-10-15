import type { BoardErrorBody, BoardErrorCode } from '@agentdock/shared';
import { HttpException } from '@nestjs/common';

/** A refusal's details beside its message: `reason`, and `no_profile`'s source and key (#272 D2). */
type BoardErrorExtra = Pick<BoardErrorBody, 'reason' | 'source' | 'profileKey'>;

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
