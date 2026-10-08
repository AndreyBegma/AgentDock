import type { ControlErrorBody, ControlErrorCode } from '@agentdock/shared';
import { HttpException } from '@nestjs/common';

/** An HTTP error of the control routes, shaped like every other API error. */
export const controlError = (
  statusCode: number,
  error: ControlErrorCode,
  message: string,
  commandRunId?: string,
): HttpException => {
  const body: ControlErrorBody = {
    statusCode,
    error,
    message,
    ...(commandRunId ? { commandRunId } : {}),
  };
  return new HttpException(body, statusCode);
};

/**
 * A control action refused or failed: the HTTP status and code it answers
 * with, before a run id is attached.
 */
export class ControlFailure extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ControlErrorCode,
    message: string,
  ) {
    super(message);
  }

  toHttp(commandRunId?: string): HttpException {
    return controlError(this.statusCode, this.code, this.message, commandRunId);
  }
}
