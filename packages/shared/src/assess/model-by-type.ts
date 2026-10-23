import {
  CARD_CI_FIX_EFFORT,
  CARD_CI_FIX_MODEL,
  type CardDecidingSignal,
  type CardEffort,
  type CardWorkClass,
} from './limits';

/**
 * #750 D2: the class a card is stored with — any deciding signal makes it
 * `deciding`, whatever class the model gave.
 */
export const effectiveWorkClass = (
  workClass: CardWorkClass,
  signals: readonly CardDecidingSignal[],
): CardWorkClass => (signals.length > 0 ? 'deciding' : workClass);

/** #750 D3: the effort a `mechanical` card's work never goes above. */
export const CARD_MECHANICAL_EFFORT_CAP: CardEffort = 'medium';

/** What `modelByType` resolves a card round to. */
export interface CardModelByType {
  model: 'opus' | 'sonnet';
  effort: CardEffort;
}

const EFFORT_RANK: Record<CardEffort, number> = { low: 0, medium: 1, high: 2 };

/**
 * #750 D3 (ADR-0076): the B arm of `model-by-type` — `deciding` → `opus` at
 * `high`, `unsure` (and no class: a missing, failed or out-of-contract
 * assessment, D1) → `opus` at `medium`, `mechanical` → `sonnet` at the
 * assessed effort capped at `medium`. A `ci_fix` round is `sonnet` at `low`
 * (ADR-0068 §5). Never `haiku`.
 */
export const modelByType = (
  workClass: CardWorkClass | null,
  assessedEffort: CardEffort | null,
  ciFix: boolean,
): CardModelByType => {
  if (ciFix) return { model: CARD_CI_FIX_MODEL, effort: CARD_CI_FIX_EFFORT };
  switch (workClass) {
    case 'deciding':
      return { model: 'opus', effort: 'high' };
    case 'mechanical': {
      const effort = assessedEffort ?? CARD_MECHANICAL_EFFORT_CAP;
      return {
        model: 'sonnet',
        effort:
          EFFORT_RANK[effort] > EFFORT_RANK[CARD_MECHANICAL_EFFORT_CAP]
            ? CARD_MECHANICAL_EFFORT_CAP
            : effort,
      };
    }
    default:
      return { model: 'opus', effort: 'medium' };
  }
};
