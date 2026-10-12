import {
  BUDGET_ERROR,
  type BudgetErrorBody,
  type BudgetErrorCode,
  type BudgetExceededBody,
  type BudgetScope,
} from '@agentdock/shared';
import { HttpException } from '@nestjs/common';

/** An HTTP error of the budget routes, shaped like every other API error. */
export const budgetError = (
  statusCode: number,
  error: BudgetErrorCode,
  message: string,
): HttpException => {
  const body: BudgetErrorBody = { statusCode, error, message };
  return new HttpException(body, statusCode);
};

export const budgetNotFound = (): HttpException =>
  budgetError(404, BUDGET_ERROR.notFound, 'Budget not found');

/** What a gated action answers once a `stop` budget is exceeded (D7, D11). */
export class BudgetExceededError extends HttpException {
  constructor(
    readonly budgetId: string,
    readonly scope: BudgetScope,
    readonly resetsAt: Date,
  ) {
    const body: BudgetExceededBody = {
      statusCode: 409,
      error: BUDGET_ERROR.exceeded,
      message: `The ${scope} budget is exceeded: no new spend until ${resetsAt.toISOString()}. Running workers continue.`,
      budgetId,
      scope,
      resetsAt: resetsAt.toISOString(),
    };
    super(body, 409);
  }
}
