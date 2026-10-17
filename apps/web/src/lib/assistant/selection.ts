import { isLlmProvider, type LlmProviderId } from '@agentdock/shared';

/** The model picker's option value; the empty string is the instance default. */
export const modelKey = (
  provider: LlmProviderId | null,
  model: string | null,
): string => (provider && model ? `${provider}::${model}` : '');

export function parseModelKey(key: string): {
  provider: LlmProviderId | null;
  model: string | null;
} {
  const at = key.indexOf('::');
  const provider = key.slice(0, at);
  if (at < 0 || !isLlmProvider(provider))
    return { provider: null, model: null };
  return { provider, model: key.slice(at + 2) };
}

/** The project picker's option value; the empty string is Auto. */
export const AUTO_PROJECT = '';
