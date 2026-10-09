import type { SchedulesErrorBody, SchedulesErrorCode } from '@agentdock/shared';
import { HttpException } from '@nestjs/common';

/** An HTTP error of the schedules routes, shaped like every other API error. */
export const schedulesError = (
  statusCode: number,
  error: SchedulesErrorCode,
  message: string,
): HttpException => {
  const body: SchedulesErrorBody = { statusCode, error, message };
  return new HttpException(body, statusCode);
};

export const scheduleNotFound = (): HttpException =>
  schedulesError(404, 'not_found', 'Schedule not found');
