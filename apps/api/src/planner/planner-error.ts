import type { PlannerErrorBody, PlannerErrorCode } from '@agentdock/shared';
import { HttpException } from '@nestjs/common';

/**
 * Retry of a turn that did not fail. Not in the shared `PLANNER_ERROR` yet;
 * the route answers it with the same body shape.
 */
export const TURN_NOT_FAILED = 'turn_not_failed';

export type PlannerFailureCode = PlannerErrorCode | typeof TURN_NOT_FAILED;

/**
 * An HTTP error of the planner routes, shaped like every other API error. Its
 * `code` lets a caller audit the refusal before rethrowing it.
 */
export class PlannerFailure extends HttpException {
  constructor(
    readonly statusCode: number,
    readonly code: PlannerFailureCode,
    message: string,
  ) {
    const body: Omit<PlannerErrorBody, 'error'> & {
      error: PlannerFailureCode;
    } = { statusCode, error: code, message };
    super(body, statusCode);
  }
}

export const plannerError = (
  statusCode: number,
  code: PlannerFailureCode,
  message: string,
): PlannerFailure => new PlannerFailure(statusCode, code, message);

/** A plan the caller cannot read is indistinguishable from one that does not exist (D12). */
export const planNotFound = (): PlannerFailure =>
  plannerError(404, 'not_found', 'Plan not found');
