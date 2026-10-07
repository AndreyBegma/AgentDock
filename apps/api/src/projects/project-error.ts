import type { ProjectErrorBody, ProjectErrorCode } from '@agentdock/shared';
import { HttpException } from '@nestjs/common';

/** An HTTP error of the projects routes, shaped like every other API error. */
export const projectError = (
  statusCode: number,
  error: ProjectErrorCode,
  message: string,
  extra: Pick<ProjectErrorBody, 'suggestedPath'> = {},
): HttpException => {
  const body: ProjectErrorBody = { statusCode, error, message, ...extra };
  return new HttpException(body, statusCode);
};

/** The one answer for a project the caller cannot see (spec 10 D12). */
export const projectNotFound = (): HttpException =>
  projectError(404, 'not_found', 'Project not found');
