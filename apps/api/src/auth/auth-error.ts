import {
  type ApiErrorBody,
  AUTH_ERROR,
  type AuthErrorCode,
} from '@nautelle/shared';
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import type { Response } from 'express';

/** An HTTP error whose body carries a stable, machine-readable code. */
export const authError = (
  statusCode: number,
  error: AuthErrorCode,
  message: string,
): HttpException => {
  const body: ApiErrorBody = { statusCode, error, message };
  return new HttpException(body, statusCode);
};

/** 429 for a source that must wait after its own failures (C-109). */
export class SourceThrottledError extends HttpException {
  constructor(readonly retryAfterS: number) {
    const body: ApiErrorBody = {
      statusCode: 429,
      error: AUTH_ERROR.throttled,
      message: 'Too many failed attempts. Wait and try again.',
    };
    super(body, 429);
  }
}

export const sourceThrottled = (waitMs: number): SourceThrottledError =>
  new SourceThrottledError(Math.max(1, Math.ceil(waitMs / 1000)));

/** Answers a `SourceThrottledError` with its `Retry-After` header. */
@Catch(SourceThrottledError)
export class SourceThrottledFilter implements ExceptionFilter {
  catch(error: SourceThrottledError, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<Response>()
      .setHeader('Retry-After', String(error.retryAfterS))
      .status(error.getStatus())
      .json(error.getResponse());
  }
}
