import type { DesignErrorBody, DesignErrorCode } from '@agentdock/shared';
import { HttpException } from '@nestjs/common';

/**
 * An HTTP error of the design routes (docs/specs/223-design-stage.md),
 * shaped like the planner's. Its `code` lets a caller audit the refusal
 * before rethrowing it.
 */
export class DesignFailure extends HttpException {
  constructor(
    readonly statusCode: number,
    readonly code: DesignErrorCode,
    message: string,
  ) {
    const body: DesignErrorBody = { statusCode, error: code, message };
    super(body, statusCode);
  }
}

export const designError = (
  statusCode: number,
  code: DesignErrorCode,
  message: string,
): DesignFailure => new DesignFailure(statusCode, code, message);
