import {
  type ApiErrorBody,
  AUTH_ERROR,
  type AuthErrorCode,
  CSRF_COOKIE,
  CSRF_HEADER,
} from '@agentdock/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: AuthErrorCode | undefined,
    message: string,
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

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
}

/** Same-origin call to the API through the `/api` rewrite (spec D12). */
export async function api<T = void>(
  path: string,
  { method = 'GET', body }: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers[CSRF_HEADER] = csrf;
  }

  const response = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as
      | (Partial<Omit<ApiErrorBody, 'message'>> & {
          message?: string | string[];
        })
      | null;
    const message = Array.isArray(error?.message)
      ? error.message.join('; ')
      : (error?.message ?? response.statusText);
    throw new ApiError(response.status, error?.error, message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** A sentence for the user; the server's message only as a last resort. */
export function describeError(error: unknown): string {
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
