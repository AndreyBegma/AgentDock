import type { LlmProviderView } from '@nautelle/shared';
import { ApiError, type Described } from '../api';

/** Spend at or above this share of the cap shows as a warning. */
export const LLM_CAP_WARN_SHARE = 0.8;

export type CapTone = 'ok' | 'warn' | 'danger' | 'neutral';

/** How full a provider's month is: `neutral` when disabled, `danger` once reached. */
export const capTone = (provider: LlmProviderView): CapTone => {
  if (!provider.enabled) return 'neutral';
  if (provider.capReached) return 'danger';
  const cap = Number(provider.capUsd);
  return Number(provider.spendUsd) >= cap * LLM_CAP_WARN_SHARE ? 'warn' : 'ok';
};

/** This month's spend as a share of the cap, 0–100; 0 for a disabled provider. */
export const capPercent = (provider: LlmProviderView): number => {
  const cap = Number(provider.capUsd);
  if (!(cap > 0)) return 0;
  return Math.min(100, Math.round((Number(provider.spendUsd) / cap) * 100));
};

/** The one-line state of a provider, as the providers table shows it. */
export const providerStatus = (
  provider: LlmProviderView,
): { label: string; tone: CapTone } => {
  if (!provider.enabled) return { label: 'Disabled', tone: 'neutral' };
  if (!provider.key.configured) return { label: 'No key', tone: 'neutral' };
  if (provider.capReached) return { label: 'Cap reached', tone: 'danger' };
  const tone = capTone(provider);
  if (tone === 'warn') {
    return { label: `${capPercent(provider)}% of cap`, tone };
  }
  if (provider.models.length === 0)
    return { label: 'No models', tone: 'neutral' };
  return { label: 'Connected', tone: 'ok' };
};

/** `…4f2a`: the only part of a key the API returns. */
export const maskedKey = (suffix: string | null): string =>
  suffix ? `…${suffix}` : 'Set';

/** "1 Nov" — the day a cap resets, in UTC. */
export const resetDay = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });

/** "October" — the UTC month spend is counted in. */
export const monthName = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });

/** A cap typed by a person: dollars, at most two decimals, 0 or more. */
export const parseCap = (text: string): number | null => {
  const value = text.trim().replace(/^\$/, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(value)) return null;
  return Number(value);
};

export function describeLlmError(error: unknown): Described {
  if (error instanceof ApiError) {
    switch (String(error.code)) {
      case 'llm_gateway_unavailable':
        return 'The server has no usable LLM_SECRETS_KEY, so the gateway is off and keys cannot be stored. Set it to 32 random bytes, base64 (`openssl rand -base64 32`), and restart the API.';
      case 'llm_key_rejected':
        return 'The provider rejected this key. Copy it again from the provider’s console.';
      case 'llm_key_missing':
        return 'No key is set for this provider.';
      case 'llm_model_unpriced':
        return {
          text: `${error.message}.`,
          href: '/admin/prices',
          cta: 'Open Prices',
        };
      case 'llm_provider_error':
        return `The provider did not answer: ${error.message}`;
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
