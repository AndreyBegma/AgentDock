import type { RunnerErrorBody, RunnerErrorCode } from '@agentdock/shared';
import { HttpException } from '@nestjs/common';

/** An HTTP error of the runners routes, shaped like every other API error. */
export const runnerError = (
  statusCode: number,
  error: RunnerErrorCode,
  message: string,
): HttpException => {
  const body: RunnerErrorBody = { statusCode, error, message };
  return new HttpException(body, statusCode);
};
