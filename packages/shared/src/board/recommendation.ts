import {
  CARD_DESIGN_RECOMMENDABLE_MODELS,
  CARD_RECOMMENDABLE_MODELS,
  type CardDesignRecommendableModel,
  type CardRecommendableModel,
} from '../assess/limits';
import type {
  CardModelRecommendation,
  CardRecommendationView,
} from './contracts';

/** The `board_cards` columns a recommendation is read from (#322 Data). */
export interface CardRecommendationColumns {
  recommendedModel: string | null;
  recommendedReason: string | null;
  recommendedDesignModel: string | null;
  recommendedDesignReason: string | null;
  assessedAt: Date | null;
}

const pick = <M extends CardRecommendableModel>(
  allowed: readonly M[],
  model: string | null,
  reason: string | null,
): CardModelRecommendation<M> | null =>
  model !== null &&
  reason !== null &&
  (allowed as readonly string[]).includes(model)
    ? { model: model as M, reason }
    : null;

/**
 * The card view's `recommendation` (#322 D6, D7). A column the contract no
 * longer allows — a model dropped from the lists — reads as no
 * recommendation, never as a value the selector cannot mark.
 */
export const cardRecommendationOf = (
  card: CardRecommendationColumns,
): CardRecommendationView => ({
  work: pick<CardRecommendableModel>(
    CARD_RECOMMENDABLE_MODELS,
    card.recommendedModel,
    card.recommendedReason,
  ),
  design: pick<CardDesignRecommendableModel>(
    CARD_DESIGN_RECOMMENDABLE_MODELS,
    card.recommendedDesignModel,
    card.recommendedDesignReason,
  ),
  assessedAt: card.assessedAt?.toISOString() ?? null,
});
