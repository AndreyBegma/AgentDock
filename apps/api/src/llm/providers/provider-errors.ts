import type { LlmProviderId } from '@agentdock/shared';
import { LlmError } from '../llm-error';
import { redactSecrets } from '../redact';

export const isAbort = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === 'AbortError' ||
    error.name === 'TimeoutError' ||
    error.name === 'APIUserAbortError');

/** Re-throws an abort as is, so a caller's cancellation stays a cancellation. */
export const rethrowAbort = (error: unknown): void => {
  if (isAbort(error)) throw error;
};

/**
 * A provider's HTTP failure as an `LlmError`: 401/403 is a rejected key,
 * anything else a provider error. The message is the provider's, with the key
 * and anything shaped like one redacted, cut to 300 characters.
 */
export const providerFailure = (
  provider: LlmProviderId,
  status: number | undefined,
  detail: string,
  apiKey: string,
): LlmError => {
  const text = redactSecrets(detail, [apiKey]).slice(0, 300);
  if (status === 401 || status === 403) {
    return new LlmError(
      'llm_key_rejected',
      `${provider} rejected the key (${status})`,
      { provider },
    );
  }
  return new LlmError(
    'llm_provider_error',
    `${provider} failed${status ? ` (${status})` : ''}: ${text}`,
    { provider },
  );
};
