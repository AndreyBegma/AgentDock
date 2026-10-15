import { ORCHESTRATOR_DEFAULTS } from '@agentdock/shared/protocol';

/**
 * #322 D2: a card's model when nothing on the card overrides it — the
 * recommendation for the action, else the project's orchestrator model,
 * else the default.
 */
export const defaultCardModel = (
  recommended: string | null | undefined,
  projectModel: string | null | undefined,
): string => recommended ?? projectModel ?? ORCHESTRATOR_DEFAULTS.model;

/**
 * #322 D3: what a launch stores for a value the person sent. Nothing when
 * nothing was sent; `null` — follow the default again — when it equals what
 * D2 would have picked without the card's override; else the value.
 */
export const rememberedChoice = (
  sent: string | undefined,
  fallback: string | null,
): string | null | undefined =>
  sent === undefined ? undefined : sent === fallback ? null : sent;
