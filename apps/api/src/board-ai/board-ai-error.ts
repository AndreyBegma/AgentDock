import type { BoardAiErrorCode } from '@nautelle/shared';
import { HttpException } from '@nestjs/common';

/** An Ask the Board or triage refusal, shaped like every other API error. */
export const boardAiError = (
  statusCode: number,
  error: BoardAiErrorCode,
  message: string,
): HttpException =>
  new HttpException({ statusCode, error, message }, statusCode);
