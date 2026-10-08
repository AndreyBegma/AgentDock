import type { ActivityErrorBody, ActivityErrorCode } from '@agentdock/shared';
import { HttpException } from '@nestjs/common';

/** An HTTP error of the activity and history routes, shaped like every other API error. */
export const activityError = (
  statusCode: number,
  error: ActivityErrorCode,
  message: string,
): HttpException => {
  const body: ActivityErrorBody = { statusCode, error, message };
  return new HttpException(body, statusCode);
};

export const badCursor = (): HttpException =>
  activityError(400, 'bad_cursor', 'The cursor is not one this API issued');
