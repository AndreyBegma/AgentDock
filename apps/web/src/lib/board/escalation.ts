import type {
  BoardCardDetail,
  BoardCardView,
  CardEscalationReason,
  CardEscalationView,
} from '@nautelle/shared';

/** #750: the face's tag on a card that escalated, and its tooltip. */
export const ESCALATED_TAG = '→ Opus';
export const ESCALATED_TAG_TITLE = 'The worker asked for Opus';

/**
 * #750 D9: the card escalated — the view's `escalated`, absent on a view
 * from before #750.
 */
export const isEscalated = (
  card: Pick<BoardCardView, 'label'> & { escalated?: boolean },
): boolean => card.escalated === true;

/**
 * #750 D9, D10: a card's escalation to Opus as the card sheet shows it — the
 * row, and whether it waits for a person with **Run on Opus**.
 */

/** The model the **Run on Opus** action launches with. */
export const RUN_ON_OPUS_MODEL = 'opus';

const REASON_TEXT: Record<CardEscalationReason, string> = {
  misclassified: 'misclassified',
  gave_up: 'gave up',
};

/** `Escalated to Opus · misclassified`; the note goes beside it. */
export const escalationTitle = (escalation: CardEscalationView): string =>
  `Escalated to Opus · ${REASON_TEXT[escalation.reason]}`;

/** D10: `The worker asks for Opus: misclassified`. */
export const escalationAsk = (escalation: CardEscalationView): string =>
  `The worker asks for Opus: ${REASON_TEXT[escalation.reason]}`;

const isOpus = (model: string): boolean =>
  model === RUN_ON_OPUS_MODEL || model.startsWith('claude-opus');

/**
 * D10: the escalation did not relaunch because the card's model is a
 * person's override that is not Opus — the card waits with **Run on Opus**.
 */
export const waitsForOpus = (
  card: Pick<BoardCardDetail, 'model'> &
    Partial<Pick<BoardCardDetail, 'escalation'>>,
): boolean =>
  Boolean(card.escalation) && card.model !== null && !isOpus(card.model);
