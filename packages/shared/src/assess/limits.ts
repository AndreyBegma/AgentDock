/**
 * Card model assessment (issue #322 D5–D8, ADR-0032): a `haiku` call on the
 * project's runner recommends a model for a card's work and its design. These
 * are its enums and limits; the API enforces them, the web shows them.
 */

/** The model of the call, with no setting (D5). */
export const CARD_ASSESS_MODEL = 'haiku';

/**
 * What a recommendation may name (D6). `fable` is selectable but never
 * recommended (Assumption A1).
 */
export const CARD_RECOMMENDABLE_MODELS = ['opus', 'sonnet', 'haiku'] as const;
export type CardRecommendableModel = (typeof CARD_RECOMMENDABLE_MODELS)[number];

/** A design recommendation chooses between these only (D6). */
export const CARD_DESIGN_RECOMMENDABLE_MODELS = ['opus', 'sonnet'] as const;
export type CardDesignRecommendableModel =
  (typeof CARD_DESIGN_RECOMMENDABLE_MODELS)[number];

/** A recommendation's one-line reason, in English (D6). */
export const CARD_ASSESS_REASON_MAX = 160;

/** `card.assess` `timeoutSec` default and range (the `text.normalize` bounds). */
export const CARD_ASSESS_TIMEOUT_SEC = 120;
export const CARD_ASSESS_MIN_TIMEOUT_SEC = 30;
export const CARD_ASSESS_MAX_TIMEOUT_SEC = 300;
/**
 * The prompt: instructions, the card's title and body (at most 20 000
 * characters), attachment names and the latest feedback (at most 8 000).
 */
export const CARD_ASSESS_PROMPT_MAX_BYTES = 96 * 1024;
/** `card_assess.finished` `result`: a short JSON object; a cut one is out of contract. */
export const CARD_ASSESS_RESULT_MAX_BYTES = 16 * 1024;
/** `card_assess.finished` `error`. */
export const CARD_ASSESS_ERROR_MAX = 2000;

/** Assessments running per project at once (D8, the normalization bound). */
export const CARD_ASSESS_MAX_RUNNING_PER_PROJECT = 2;

/** The BullMQ queue of D6 (ADR-0015). */
export const CARD_ASSESS_QUEUE = 'card-assess';

/**
 * The job id of one card's assessment for one input hash, so a repeated
 * enqueue of the same input is one job. Not `card-assess:<id>`: BullMQ 5
 * refuses a custom id with a single `:` (the `captureJobId` precedent).
 */
export const cardAssessJobId = (cardId: string, hash: string): string =>
  `card-assess-${cardId}-${hash}`;
