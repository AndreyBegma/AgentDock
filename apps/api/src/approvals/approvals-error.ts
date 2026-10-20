import type { ApprovalsErrorBody, ApprovalsErrorCode } from '@nautelle/shared';
import { HttpException } from '@nestjs/common';

/** An HTTP error of the approvals routes, shaped like every other API error. */
export const approvalsError = (
  statusCode: number,
  error: ApprovalsErrorCode,
  message: string,
  extra: Pick<ApprovalsErrorBody, 'headSha'> = {},
): HttpException => {
  const body: ApprovalsErrorBody = { statusCode, error, message, ...extra };
  return new HttpException(body, statusCode);
};
