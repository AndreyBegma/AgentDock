import type {
  DesignErrorBody,
  DesignErrorCode,
  NoProfileDetails,
} from '@agentdock/shared';
import { HttpException } from '@nestjs/common';

/**
 * An HTTP error of the design routes (docs/specs/223-design-stage.md),
 * shaped like the planner's. Its `code` lets a caller audit the refusal
 * before rethrowing it. `extra` carries a `no_profile` refusal's details
 * (#272 D2).
 */
export class DesignFailure extends HttpException {
  constructor(
    readonly statusCode: number,
    readonly code: DesignErrorCode,
    message: string,
    extra: Partial<NoProfileDetails> = {},
  ) {
    const body: DesignErrorBody = {
      statusCode,
      error: code,
      message,
      ...extra,
    };
    super(body, statusCode);
  }
}

export const designError = (
  statusCode: number,
  code: DesignErrorCode,
  message: string,
  extra: Partial<NoProfileDetails> = {},
): DesignFailure => new DesignFailure(statusCode, code, message, extra);
