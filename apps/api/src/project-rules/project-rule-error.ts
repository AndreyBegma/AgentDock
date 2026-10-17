import {
  PROJECT_RULE_ERROR,
  type ProjectRuleErrorBody,
  type ProjectRuleErrorCode,
} from '@agentdock/shared';
import { HttpException } from '@nestjs/common';

/** An HTTP error of the rule routes, shaped like every other API error. */
export const projectRuleError = (
  statusCode: number,
  error: ProjectRuleErrorCode,
  message: string,
): HttpException => {
  const body: ProjectRuleErrorBody = { statusCode, error, message };
  return new HttpException(body, statusCode);
};

export const projectRuleNotFound = (): HttpException =>
  projectRuleError(404, PROJECT_RULE_ERROR.notFound, 'Rule not found');
