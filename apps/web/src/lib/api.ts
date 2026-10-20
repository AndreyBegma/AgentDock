import {
  type ApiErrorBody,
  AUTH_ERROR,
  type AuthErrorCode,
  CSRF_COOKIE,
  CSRF_HEADER,
} from '@nautelle/shared';
import { reachability } from './live/reachability';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: AuthErrorCode | undefined,
    message: string,
    /** With a projects `not_main_checkout`: the main checkout to use instead. */
    readonly suggestedPath?: string,
    /** The parsed error body, for fields a route adds (e.g. `labels`); null when it was not JSON. */
    readonly body: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

const readCookie = (name: string): string | undefined => {
  for (const part of document.cookie.split('; ')) {
    const eq = part.indexOf('=');
    if (part.slice(0, eq) === name) {
      return decodeURIComponent(part.slice(eq + 1));
    }
  }
  return undefined;
};

/** The CSRF header a write carries, for calls that cannot go through `api` (a stream). */
export const csrfHeaders = (): Record<string, string> => {
  const csrf = readCookie(CSRF_COOKIE);
  return csrf ? { [CSRF_HEADER]: csrf } : {};
};

interface RequestOptions {
  method?: 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
}

/** What a write says when the API was unreachable: the request never landed. */
export const RESTARTING_WRITE_MESSAGE =
  'Nautelle was restarting — nothing was changed. Try again';
/** What a read says once its retries ran out. */
export const RESTARTING_READ_MESSAGE =
  'Nautelle is restarting and could not be reached. Try again in a moment.';

/** The API could not be reached, or answered 502/503/504 (spec 353 D1). */
export class ApiUnreachableError extends ApiError {
  constructor(status: number, message: string) {
    super(status, undefined, message);
  }
}

/** Read retries: 0.5, 1, 2, 4, 8 s, then 8 s again, 30 s in all (spec 353 D3). */
export const READ_RETRY_BASE_MS = 500;
export const READ_RETRY_STEP_CAP_MS = 8_000;
export const READ_RETRY_BUDGET_MS = 30_000;

export const readRetryDelay = (attempt: number): number =>
  Math.min(READ_RETRY_STEP_CAP_MS, READ_RETRY_BASE_MS * 2 ** attempt);

/** Swapped by tests; the real thing waits. */
export const apiRuntime = {
  sleep: (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms)),
};

const isGatewayStatus = (status: number) =>
  status === 502 || status === 503 || status === 504;

/** Same-origin call to the API through the `/api` rewrite (spec D12). */
export async function api<T = void>(
  path: string,
  { method = 'GET', body }: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const safe = method === 'GET' || method === 'HEAD';
  if (!safe) {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers[CSRF_HEADER] = csrf;
  }

  let waited = 0;
  for (let attempt = 0; ; attempt += 1) {
    let response: Response | undefined;
    try {
      response = await fetch(`/api${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      response = undefined;
    }

    if (response && !isGatewayStatus(response.status)) {
      reachability.markReachable();
      return settle<T>(response);
    }

    reachability.markUnreachable();
    const status = response?.status ?? 503;
    if (!safe) {
      throw new ApiUnreachableError(status, RESTARTING_WRITE_MESSAGE);
    }
    const delay = readRetryDelay(attempt);
    if (waited + delay > READ_RETRY_BUDGET_MS) {
      throw new ApiUnreachableError(status, RESTARTING_READ_MESSAGE);
    }
    waited += delay;
    await apiRuntime.sleep(delay);
  }
}

async function settle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as
      | (Partial<Omit<ApiErrorBody, 'message'>> & {
          message?: string | string[];
          suggestedPath?: string;
        })
      | null;
    const message = Array.isArray(error?.message)
      ? error.message.join('; ')
      : (error?.message ?? response.statusText);
    throw new ApiError(
      response.status,
      error?.error,
      message,
      error?.suggestedPath,
      error as Record<string, unknown> | null,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * An error as the user reads it: the sentence, and where to go to fix it.
 * `href` and `cta` come together or not at all.
 */
export interface ErrorHint {
  text: string;
  href?: string;
  cta?: string;
}

/** What a `describe…Error` helper returns: a sentence, or a sentence with a fix. */
export type Described = string | ErrorHint;

export const toErrorHint = (described: Described): ErrorHint =>
  typeof described === 'string' ? { text: described } : described;

export const errorText = (described: Described): string =>
  typeof described === 'string' ? described : described.text;

/**
 * The sonner options for a toast built from a hint: an action that navigates
 * to the fix when the hint names one.
 */
export function errorToastOptions(
  described: Described,
  navigate: (href: string) => void,
): { action?: { label: string; onClick: () => void } } {
  const { href, cta } = toErrorHint(described);
  if (!href || !cta) return {};
  return { action: { label: cta, onClick: () => navigate(href) } };
}

/** `describeError` as a hint, with a link where the fix lives on another page. */
export function describeErrorHint(error: unknown): ErrorHint {
  const text = describeError(error);
  if (error instanceof ApiError && error.code === AUTH_ERROR.forbidden) {
    return { text, href: '/', cta: 'Go to Overview' };
  }
  return { text };
}

/** A sentence for the user; the server's message only as a last resort. */
export function describeError(error: unknown): string {
  if (error instanceof ApiUnreachableError) return error.message;
  if (!(error instanceof ApiError)) return 'Could not reach the server.';
  switch (error.code) {
    case AUTH_ERROR.invalidCredentials:
      return 'Wrong email or password.';
    case AUTH_ERROR.pendingApproval:
      return 'Your account is waiting for an administrator to approve it.';
    case AUTH_ERROR.registrationClosed:
      return 'Registration is closed.';
    case AUTH_ERROR.emailTaken:
      return 'An account with this email already exists.';
    case AUTH_ERROR.lastAdmin:
      return 'This is the last active administrator and cannot be changed or removed.';
    case AUTH_ERROR.invalidTransition:
      return 'This account is no longer in a state where that is possible. Refresh the list.';
    case AUTH_ERROR.csrfFailed:
      return 'Your session token is out of date. Reload the page and try again.';
    case AUTH_ERROR.notFound:
      return 'It no longer exists. Refresh the list.';
    case AUTH_ERROR.forbidden:
      return 'You do not have access to this.';
    default:
      return error.status === 429
        ? 'Too many attempts. Wait a minute and try again.'
        : error.message;
  }
}
