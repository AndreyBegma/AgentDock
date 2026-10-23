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

/**
 * #663 (ADR-0068 §5): the Claude CLI's `--effort` a card's work may run at,
 * recommended next to the model. The CLI knows `xhigh` and `max` too; a card
 * never needs them.
 */
export const CARD_EFFORTS = ['low', 'medium', 'high'] as const;
export type CardEffort = (typeof CARD_EFFORTS)[number];

/** #663 (ADR-0068 §5): a `ci_fix` round's model and effort unless the card overrides them. */
export const CARD_CI_FIX_MODEL = 'sonnet';
export const CARD_CI_FIX_EFFORT: CardEffort = 'low';

/**
 * #750 D1 (ADR-0076): what the card's work still has to decide —
 * `mechanical` executes a clear decision, `deciding` still has to make one,
 * `unsure` is neither shown. A missing, failed or out-of-contract assessment
 * counts as `unsure`.
 */
export const CARD_WORK_CLASSES = ['mechanical', 'deciding', 'unsure'] as const;
export type CardWorkClass = (typeof CARD_WORK_CLASSES)[number];

/**
 * #750 D2: the closed list of deciding signals. Any one of them makes the
 * class `deciding`, whatever the model said.
 */
export const CARD_DECIDING_SIGNALS = [
  /** A database schema, a migration, or a stored format. */
  'schema',
  /** Authentication, authorization, roles. */
  'auth',
  /** Data isolation between projects, organizations or users. */
  'tenancy',
  /** Billing, prices, budgets that stop spend. */
  'payments',
  /** Deleting or purging stored data, or a destructive git operation. */
  'deletion',
  /** A `bug` card whose root cause is not shown in the card. */
  'bug_cause_unknown',
  /** No existing pattern in the project to follow. */
  'no_precedent',
] as const;
export type CardDecidingSignal = (typeof CARD_DECIDING_SIGNALS)[number];

/** #750 D8: why a card worker calls `escalate_card`. */
export const CARD_ESCALATION_REASONS = ['misclassified', 'gave_up'] as const;
export type CardEscalationReason = (typeof CARD_ESCALATION_REASONS)[number];

/** #750 D8: the `escalate_card` note on what the worker found and why. */
export const CARD_ESCALATION_NOTE_MAX = 2000;

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
