import type { PlannerErrorBody, PlannerErrorCode } from '@agentdock/shared';
import { HttpException } from '@nestjs/common';

/**
 * An HTTP error of the planner routes, shaped like every other API error. Its
 * `code` lets a caller audit the refusal before rethrowing it.
 */
export class PlannerFailure extends HttpException {
  constructor(
    readonly statusCode: number,
    readonly code: PlannerErrorCode,
    message: string,
  ) {
    const body: PlannerErrorBody = { statusCode, error: code, message };
    super(body, statusCode);
  }
}

export const plannerError = (
  statusCode: number,
  code: PlannerErrorCode,
  message: string,
): PlannerFailure => new PlannerFailure(statusCode, code, message);

/** A plan the caller cannot read is indistinguishable from one that does not exist (D12). */
export const planNotFound = (): PlannerFailure =>
  plannerError(404, 'not_found', 'Plan not found');
