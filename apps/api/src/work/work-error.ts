import { WORK_ERROR, type WorkErrorCode } from '@nautelle/shared';
import { HttpException } from '@nestjs/common';

/** An HTTP error of the work routes, shaped like every other API error. */
export class WorkFailure extends HttpException {
  constructor(
    readonly statusCode: number,
    readonly code: WorkErrorCode,
    message: string,
  ) {
    super({ statusCode, error: code, message }, statusCode);
  }
}

export const unknownCursor = (): WorkFailure =>
  new WorkFailure(400, WORK_ERROR.invalidArgs, 'Unknown cursor');
