import type { WorkflowErrorBody, WorkflowErrorCode } from '@agentdock/shared';
import { HttpException } from '@nestjs/common';

/** An HTTP error of the workflows routes, shaped like every other API error. */
export const workflowError = (
  statusCode: number,
  error: WorkflowErrorCode,
  message: string,
): HttpException => {
  const body: WorkflowErrorBody = { statusCode, error, message };
  return new HttpException(body, statusCode);
};

/** The one answer for a project the caller cannot see, as for projects. */
export const workflowProjectNotFound = (): HttpException =>
  workflowError(404, 'not_found', 'Project not found');
