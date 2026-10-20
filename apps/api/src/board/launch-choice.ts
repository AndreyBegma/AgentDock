import {
  CARD_CI_FIX_EFFORT,
  CARD_CI_FIX_MODEL,
  type CardEffort,
} from '@nautelle/shared';
import { ORCHESTRATOR_DEFAULTS } from '@nautelle/shared/protocol';

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
 * #663 (ADR-0068 §5): a round's default model and effort before the card's
 * overrides. A `ci_fix` round is mechanical: `sonnet` at `low`. Any other
 * takes the recommendation's model (D2) and effort; no effort is the CLI's
 * own default.
 */
export const defaultCardLaunch = (
  ciFix: boolean,
  recommended: { model: string; effort: CardEffort | null } | null,
  projectModel: string | null | undefined,
): { model: string; effort: CardEffort | null } =>
  ciFix
    ? { model: CARD_CI_FIX_MODEL, effort: CARD_CI_FIX_EFFORT }
    : {
        model: defaultCardModel(recommended?.model, projectModel),
        effort: recommended?.effort ?? null,
      };

/**
 * #322 D3: what a launch stores for a value the person sent. Nothing when
 * nothing was sent; `null` — follow the default again — when it equals what
 * D2 would have picked without the card's override; else the value.
 */
export const rememberedChoice = <T extends string>(
  sent: T | undefined,
  fallback: T | null,
): T | null | undefined =>
  sent === undefined ? undefined : sent === fallback ? null : sent;
