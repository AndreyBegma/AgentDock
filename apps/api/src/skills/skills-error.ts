import type { SkillsErrorBody, SkillsErrorCode } from '@agentdock/shared';
import { HttpException } from '@nestjs/common';

/**
 * An HTTP error of the skills routes, shaped like every other API error. Its
 * `code` lets a caller audit the refusal before rethrowing it.
 */
export class SkillsFailure extends HttpException {
  constructor(
    readonly statusCode: number,
    readonly code: SkillsErrorCode,
    message: string,
    extra: Pick<SkillsErrorBody, 'runId'> = {},
  ) {
    const body: SkillsErrorBody = {
      statusCode,
      error: code,
      message,
      ...extra,
    };
    super(body, statusCode);
  }

  /** The same failure, naming the run it was recorded on. */
  withRun(runId: string): SkillsFailure {
    return new SkillsFailure(this.statusCode, this.code, this.message, {
      runId,
    });
  }
}

export const skillsError = (
  statusCode: number,
  code: SkillsErrorCode,
  message: string,
): SkillsFailure => new SkillsFailure(statusCode, code, message);
