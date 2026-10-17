/**
 * Text normalization (issue #271, ADR-0027): free text people save is stored
 * in English, translated asynchronously by a small model on the project's
 * runner. These are its enums and limits; the API enforces them, the web shows
 * them. Several are [Assumption] values of the issue (D4, D5, D11) — change
 * them here, where review sees it.
 */

/** Mirrors the Prisma enum `TextOwnerType`: who owns a normalized text (D1). */
export const TEXT_OWNER_TYPES = [
  'board_card',
  'board_card_round',
  'design_comment',
  'plan',
  'plan_task',
  'plan_turn',
  /** #584: a rule created from a scanned candidate. */
  'project_rule',
] as const;
export type TextOwnerType = (typeof TEXT_OWNER_TYPES)[number];

export const isTextOwnerType = (value: string): value is TextOwnerType =>
  (TEXT_OWNER_TYPES as readonly string[]).includes(value);

/**
 * Mirrors `text_normalizations.status` (Prisma `TextNormalizationStatus`):
 * - `pending` — waiting in the queue, or backing off while the runner is offline;
 * - `running` — its `text.normalize` run is on the runner;
 * - `done` — the result was applied, field by field (D8);
 * - `skipped` — not run: the switch is off or a budget stopped it (`failReason`);
 * - `failed` — gave up (`failReason`); an operator may retry;
 * - `superseded` — a newer request for the same owner replaced it before it ran (D8).
 */
export const TEXT_NORMALIZATION_STATUSES = [
  'pending',
  'running',
  'done',
  'skipped',
  'failed',
  'superseded',
] as const;
export type TextNormalizationStatus =
  (typeof TEXT_NORMALIZATION_STATUSES)[number];

/**
 * Why a request is `failed` or `skipped` (`text_normalizations.failReason`,
 * Prisma `TextFailReason`), D11:
 * - `runner_offline` — still offline after `TEXT_OFFLINE_GIVE_UP_MS` (failed);
 * - `runner_unsupported` — the runner does not advertise `text.normalize` (failed);
 * - `no_profile` — no usable Claude profile (failed);
 * - `run_failed` — the run errored or timed out `TEXT_RUN_RETRIES + 1` times (failed);
 * - `contract_violation` — the output broke the contract (failed, no retry);
 * - `budget_exceeded` — a project budget's hard stop (skipped);
 * - `off` — normalization was switched off before it ran (skipped).
 */
export const TEXT_FAIL_REASONS = [
  'runner_offline',
  'runner_unsupported',
  'no_profile',
  'run_failed',
  'contract_violation',
  'budget_exceeded',
  'off',
] as const;
export type TextFailReason = (typeof TEXT_FAIL_REASONS)[number];

export const isTextFailReason = (value: string): value is TextFailReason =>
  (TEXT_FAIL_REASONS as readonly string[]).includes(value);

/**
 * One field's outcome inside a request (`fields[].outcome`), D5–D8:
 * - `translated` — the English text was applied to the column;
 * - `already_english` — skipped by `isReliablyEnglish`, or the model said so;
 * - `rejected` — the output lost, repeated or invented a placeholder (D6);
 * - `superseded` — the column changed after the request was made (D8).
 *
 * Absent while the request has not finished.
 */
export const TEXT_FIELD_OUTCOMES = [
  'translated',
  'already_english',
  'rejected',
  'superseded',
] as const;
export type TextFieldOutcome = (typeof TEXT_FIELD_OUTCOMES)[number];

/** Mirrors the Prisma enum `CardKindSource` (D9): who set a card's kind. */
export const CARD_KIND_SOURCES = ['auto', 'person'] as const;
export type CardKindSource = (typeof CARD_KIND_SOURCES)[number];

// D1 — the normalized fields of each owner.

/** A plan turn's free-text answer is the field `answers.<questionId>`. */
export const TEXT_ANSWER_FIELD_PREFIX = 'answers.';

export const textAnswerField = (questionId: string): string =>
  `${TEXT_ANSWER_FIELD_PREFIX}${questionId}`;

/** The fixed field names of each owner; `plan_turn` also has `answers.<id>`. */
export const TEXT_OWNER_FIELDS = {
  board_card: ['title', 'body'],
  board_card_round: ['feedback'],
  design_comment: ['body'],
  plan: ['brief'],
  plan_task: ['rewriteComment'],
  plan_turn: ['message'],
  project_rule: ['title', 'description'],
} as const satisfies Record<TextOwnerType, readonly string[]>;

const ANSWER_FIELD = /^answers\.[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** Whether `field` is a normalized field of `ownerType` (D1). */
export const isTextField = (ownerType: TextOwnerType, field: string): boolean =>
  (TEXT_OWNER_FIELDS[ownerType] as readonly string[]).includes(field) ||
  (ownerType === 'plan_turn' && ANSWER_FIELD.test(field));

// D7 — storage.

/** `fields[].original`: the longest normalized column is a card body. */
export const TEXT_ORIGINAL_MAX = 20_000;
/** `text_normalizations.error`. */
export const TEXT_ERROR_MAX = 2000;
/** Fields of one request: a card's two, or a turn's message and answers. */
export const TEXT_FIELDS_MAX = 32;

// D4 — the call.

/** The model, with no setting (D4). */
export const TEXT_NORMALIZE_MODEL = 'haiku';
/** `text.normalize` `timeoutSec` default and range (D11). */
export const TEXT_NORMALIZE_TIMEOUT_SEC = 120;
export const TEXT_NORMALIZE_MIN_TIMEOUT_SEC = 30;
export const TEXT_NORMALIZE_MAX_TIMEOUT_SEC = 300;
/** The prompt: instructions, contract and every field, masked. */
export const TEXT_PROMPT_MAX_BYTES = 96 * 1024;
/** `text_normalize.finished` `result`; a cut result is a contract violation. */
export const TEXT_RESULT_MAX_BYTES = 96 * 1024;

// D11 — failure and retry.

/** A run that errors or times out is retried this many times. */
export const TEXT_RUN_RETRIES = 2;
/** Runner offline: the first wait; each next one doubles. */
export const TEXT_OFFLINE_BACKOFF_BASE_MS = 60 * 1000;
/** Runner offline: no single wait is longer. */
export const TEXT_OFFLINE_BACKOFF_STEP_MAX_MS = 30 * 60 * 1000;
/** Runner offline this long after the request: `failed: runner_offline`. */
export const TEXT_OFFLINE_GIVE_UP_MS = 24 * 60 * 60 * 1000;
/** Running requests per project at once. */
export const TEXT_MAX_RUNNING_PER_PROJECT = 2;

/**
 * The wait before offline attempt `attempt` (0-based): 1, 2, 4, … minutes,
 * at most `TEXT_OFFLINE_BACKOFF_STEP_MAX_MS`.
 */
export const textOfflineBackoffMs = (attempt: number): number =>
  Math.min(
    TEXT_OFFLINE_BACKOFF_BASE_MS * 2 ** Math.max(0, Math.min(attempt, 30)),
    TEXT_OFFLINE_BACKOFF_STEP_MAX_MS,
  );

/** The BullMQ queue of D3 (ADR-0015). */
export const TEXT_NORMALIZE_QUEUE = 'text-normalize';

/**
 * The job id of one request. Not `text:<id>`: BullMQ 5 refuses a custom id
 * with a single `:` (the `captureJobId` precedent).
 */
export const textNormalizeJobId = (normalizationId: string): string =>
  `text-normalize-${normalizationId}`;
