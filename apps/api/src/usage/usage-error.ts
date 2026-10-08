import type { UsageErrorBody, UsageErrorCode } from '@agentdock/shared';
import { HttpException } from '@nestjs/common';

/** An HTTP error of the usage and price routes, shaped like every other API error. */
export const usageError = (
  statusCode: number,
  error: UsageErrorCode,
  message: string,
): HttpException => {
  const body: UsageErrorBody = { statusCode, error, message };
  return new HttpException(body, statusCode);
};

/** A project the caller cannot see is 404, never 403 (spec 13 D9, as for projects). */
export const usageProjectNotFound = (): HttpException =>
  usageError(404, 'not_found', 'Project not found');
