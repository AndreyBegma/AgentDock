import type { QueueErrorBody, QueueErrorCode } from '@agentdock/shared';
import { HttpException } from '@nestjs/common';

/** An HTTP error of the queue routes, shaped like every other API error. */
export const queueError = (
  statusCode: number,
  error: QueueErrorCode,
  message: string,
  extra: Pick<QueueErrorBody, 'labels'> = {},
): HttpException => {
  const body: QueueErrorBody = { statusCode, error, message, ...extra };
  return new HttpException(body, statusCode);
};
