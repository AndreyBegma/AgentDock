import { BUDGET_ERROR } from '@nautelle/shared';
import {
  LOCAL_BOARD_REFUSALS,
  LOCAL_DESIGN_REFUSALS,
  type LocalErrorCode,
} from '@nautelle/shared/protocol';
import { HttpException } from '@nestjs/common';

/** A typed refusal of a local request: becomes `local.response {ok: false}`. */
export class LocalError extends Error {
  constructor(
    readonly code: LocalErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The `{ error, message }` of an API error body, when it has them. */
export const httpErrorBody = (
  error: HttpException,
): { code: string | null; message: string } => {
  const body = error.getResponse();
  if (typeof body === 'string') return { code: null, message: body };
  const record = body as Record<string, unknown>;
  const code = typeof record.error === 'string' ? record.error : null;
  const raw = record.message;
  const message = Array.isArray(raw)
    ? raw.join('; ')
    : typeof raw === 'string'
      ? raw
      : error.message;
  return { code, message };
};

type LocalRefusal =
  | (typeof LOCAL_BOARD_REFUSALS)[number]
  | (typeof LOCAL_DESIGN_REFUSALS)[number];

const REFUSALS: readonly string[] = [
  ...LOCAL_BOARD_REFUSALS,
  ...LOCAL_DESIGN_REFUSALS,
];

const refusalOf = (code: string | null): LocalRefusal | null =>
  code !== null && REFUSALS.includes(code) ? (code as LocalRefusal) : null;

/** A board error body's `reason`, when it has one. */
const reasonOf = (error: HttpException): string | null => {
  const body = error.getResponse();
  if (typeof body !== 'object' || body === null) return null;
  const reason = (body as Record<string, unknown>).reason;
  return typeof reason === 'string' ? reason : null;
};

/**
 * A domain service's HTTP error, in the local allowlist's words (D7). The
 * message is the service's own, never a stack trace.
 */
export const toLocalError = (error: unknown): LocalError => {
  if (error instanceof LocalError) return error;
  if (!(error instanceof HttpException)) {
    return new LocalError('internal', 'internal error');
  }
  const { code, message } = httpErrorBody(error);
  const status = error.getStatus();
  // #845 D3: the Board's own refusals keep their names, as do the design
  // routes' (C-377); `move_refused` carries its `BoardMoveRefusal`.
  const refusal = refusalOf(code);
  if (refusal) {
    const reason = reasonOf(error);
    return new LocalError(
      refusal,
      refusal === 'move_refused' && reason ? reason : message,
    );
  }
  if (code === BUDGET_ERROR.exceeded) {
    return new LocalError('budget_exceeded', message);
  }
  if (status === 404) return new LocalError('not_found', message);
  if (status === 401 || status === 403) {
    return new LocalError('forbidden', message);
  }
  if (status === 400 || status === 422) {
    return new LocalError('invalid_args', message);
  }
  if (code === 'runner_offline' || status === 503) {
    return new LocalError('runner_offline', message);
  }
  return new LocalError('internal', message);
};
