/**
 * Card capture (issue #244, ADR-0026): a small model reads new prompts and
 * final responses of a person's own manual Claude Code sessions and proposes
 * candidate cards for the Board's Inbox. These are its limits and enums; the
 * API enforces them, the web shows them. Several are [Assumption] values of
 * the issue (D6, D7) — change them here, where review sees it.
 */

/** D4: the models a project may pick for extraction; `haiku` by default. */
export const CAPTURE_MODELS = ['haiku', 'sonnet'] as const;
export type CaptureModel = (typeof CAPTURE_MODELS)[number];
export const CAPTURE_MODEL_DEFAULT: CaptureModel = 'haiku';

export const isCaptureModel = (value: string): value is CaptureModel =>
  (CAPTURE_MODELS as readonly string[]).includes(value);

/** Mirrors the `card_captures.status` values. */
export const CAPTURE_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'skipped',
] as const;
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

/**
 * Why an extraction was `skipped` (`card_captures.skipReason`), mirrored by
 * the Prisma enum `CardCaptureSkipReason`:
 * - `too_little` — under `CAPTURE_MIN_INPUT_CHARS` of new content (D3);
 * - `rate_limited` — the project's 24 h or the session's 30 min limit (D7);
 * - `inbox_full` — the Inbox holds `CAPTURE_INBOX_MAX` cards (D7);
 * - `budget_exceeded` — a project budget's hard stop (D7);
 * - `runner_offline` — still offline after `CAPTURE_OFFLINE_BACKOFF_MAX_MS` (D7);
 * - `capture_off` — content or capture was turned off before it ran (D1);
 * - `no_profile` — no usable runtime profile (#272 D8).
 *
 * An output that breaks the D5 contract is not a skip: the row is `failed`
 * with `error` = `contract_violation: <CaptureViolation>` (`captureViolationError`).
 */
export const CAPTURE_SKIP_REASONS = [
  'too_little',
  'rate_limited',
  'inbox_full',
  'budget_exceeded',
  'runner_offline',
  'capture_off',
  'no_profile',
] as const;
export type CaptureSkipReason = (typeof CAPTURE_SKIP_REASONS)[number];

// D2 — triggers.

/** `hook.session_ended` → extract this long after, so async hook content lands first. */
export const CAPTURE_SESSION_END_DELAY_MS = 2 * 60 * 1000;
/** Each `hook.stopped` (re)schedules the session's job this long after: read on idle. */
export const CAPTURE_IDLE_DELAY_MS = 20 * 60 * 1000;

/**
 * The BullMQ job id of a session's delayed extraction (one per session).
 * Not `capture:<id>` as the issue wrote: BullMQ 5 refuses a custom id with a
 * single `:` ("Custom Id cannot contain :").
 */
export const captureJobId = (sessionId: string): string =>
  `capture-${sessionId}`;

// D3 — content used.

/** A `prompt` row contributes its first 2 KiB (UTF-8). */
export const CAPTURE_PROMPT_HEAD_BYTES = 2 * 1024;
/** A `response` row contributes its last 1 KiB (UTF-8). */
export const CAPTURE_RESPONSE_TAIL_BYTES = 1024;
/** All content of one extraction, newest first. */
export const CAPTURE_INPUT_MAX_BYTES = 24 * 1024;
/** Under this many characters of new content, the extraction is skipped `too_little`. */
export const CAPTURE_MIN_INPUT_CHARS = 300;
/** Open card titles in the prompt, for dedupe. */
export const CAPTURE_OPEN_TITLES_MAX = 100;

// D5 — the output contract.

export const CAPTURE_MAX_CARDS = 5;
export const CAPTURE_TITLE_MAX = 120;
export const CAPTURE_BODY_MAX = 2000;
export const CAPTURE_WHY_MAX = 300;
export const CAPTURE_EVIDENCE_MIN = 1;
export const CAPTURE_EVIDENCE_MAX = 5;
/** D8: evidence text kept on an Inbox card, per content id. */
export const CAPTURE_EVIDENCE_EXCERPT_MAX = 300;

// D6 — dedupe.

/** A suggestion below this confidence is dropped. */
export const CAPTURE_MIN_CONFIDENCE = 0.6;
/** A card completed this recently still blocks its fingerprint. */
export const CAPTURE_COMPLETED_DEDUPE_DAYS = 30;
/** A dismissal blocks its fingerprint this long; the daily job deletes older rows. */
export const CAPTURE_DISMISSAL_DEDUPE_DAYS = 90;

// D7 — limits.

/** Running extractions per project at once. */
export const CAPTURE_MAX_RUNNING_PER_PROJECT = 1;
/** Extractions per project in a rolling 24 h; the next one is `skipped`. */
export const CAPTURE_MAX_PER_PROJECT_PER_DAY = 48;
/** At most one extraction per session in this window. */
export const CAPTURE_SESSION_MIN_INTERVAL_MS = 30 * 60 * 1000;
/** With this many Inbox cards, an extraction is skipped `inbox_full`. */
export const CAPTURE_INBOX_MAX = 30;
/** `cards.extract` `timeoutSec` default and range. */
export const CAPTURE_TIMEOUT_SEC = 180;
export const CAPTURE_MIN_TIMEOUT_SEC = 30;
export const CAPTURE_MAX_TIMEOUT_SEC = 600;
/** A failed extraction is retried once. */
export const CAPTURE_RETRIES = 1;
/** With the runner offline, back off up to this long, then `skipped: runner_offline`. */
export const CAPTURE_OFFLINE_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

// Storage.

/** `card_captures.resultText`, deleted with content retention. */
export const CAPTURE_RESULT_MAX_BYTES = 32 * 1024;

/** `GET /board/captures` page size. */
export const CAPTURE_PAGE_SIZE = 50;
