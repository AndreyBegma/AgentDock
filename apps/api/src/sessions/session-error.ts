import type { SessionErrorBody, SessionErrorCode } from '@agentdock/shared';
import { HttpException } from '@nestjs/common';

/** An HTTP error of the sessions routes, shaped like every other API error. */
export const sessionError = (
  statusCode: number,
  error: SessionErrorCode,
  message: string,
): HttpException => {
  const body: SessionErrorBody = { statusCode, error, message };
  return new HttpException(body, statusCode);
};

/** The one answer for a session the caller cannot see (D10), as for projects. */
export const sessionNotFound = (): HttpException =>
  sessionError(404, 'not_found', 'Session not found');
