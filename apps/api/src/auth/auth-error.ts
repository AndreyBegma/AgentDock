import type { ApiErrorBody, AuthErrorCode } from '@agentdock/shared';
import { HttpException } from '@nestjs/common';

/** An HTTP error whose body carries a stable, machine-readable code. */
export const authError = (
  statusCode: number,
  error: AuthErrorCode,
  message: string,
): HttpException => {
  const body: ApiErrorBody = { statusCode, error, message };
  return new HttpException(body, statusCode);
};
