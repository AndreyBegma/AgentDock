import type { LlmErrorCode, LlmProviderId } from '../llm';

/**
 * The daily AI digest and the one-click summaries (#658): both are made by the
 * API's LLM gateway (ADR-0059), tagged `digest` and `summary` in the usage
 * ledger, and bounded by the providers' monthly caps.
 */

// ─── Daily digest ───────────────────────────────────────────────────────────

/** `HH:MM`, 24-hour. */
export const AI_DIGEST_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A project with no setting row: off, at 09:00 in UTC. */
export const AI_DIGEST_DEFAULTS = {
  enabled: false,
  time: '09:00',
  timezone: 'UTC',
} as const;

/** `GET` / `PATCH /projects/:id/ai/digest/settings`. */
export interface AiDigestSettingsView {
  enabled: boolean;
  /** `HH:MM` in `timezone`. */
  time: string;
  /** IANA zone, e.g. `Europe/Kyiv`. */
  timezone: string;
  /** null while the project uses the defaults. */
  updatedAt: string | null;
}

export interface UpdateAiDigestSettings {
  enabled?: boolean;
  time?: string;
  timezone?: string;
}

/** Whether `zone` is an IANA timezone this runtime knows. */
export const isTimeZone = (zone: string): boolean => {
  if (zone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/** `pending` claims an occurrence while it is made. */
export const AI_DIGEST_STATUSES = ['pending', 'sent', 'skipped'] as const;
export type AiDigestStatus = (typeof AI_DIGEST_STATUSES)[number];

/** One line of a digest section: a card, a PR, an incident. */
export interface AiDigestItem {
  /** `C-12`, `Run`, a slot name. */
  label: string;
  title: string;
  /** Why it is in the section, in one line. */
  reason: string | null;
  /** The PR, else the card on the web Board; null when there is neither. */
  url: string | null;
}

/** The three sections a digest separates (#658). */
export interface AiDigestSections {
  /** Merged PRs and finished rounds. */
  done: AiDigestItem[];
  /** Failing PRs, failed rounds and Steward incidents. */
  stuck: AiDigestItem[];
  /** What waits for a person: a question, a review, a new card to triage. */
  waiting: AiDigestItem[];
}

/** `GET /projects/:id/ai/digest/latest`: the newest digest that was sent. */
export interface AiDigestView extends AiDigestSections {
  id: string;
  projectId: string;
  /** The occurrence it was made for. */
  dueAt: string;
  /** The period covered, ISO. */
  from: string;
  to: string;
  /** The model's few sentences over the sections, in English. */
  overview: string;
  provider: LlmProviderId;
  model: string;
  createdAt: string;
}

/** Why a due digest was not made: the gateway's refusal, or no model to use. */
export type AiDigestSkipReason = LlmErrorCode | 'no_model';

/** The `events` the API records for a digest (ADR-0014). */
export const AI_DIGEST_EVENTS = {
  sent: 'ai_digest.sent',
  skipped: 'ai_digest.skipped',
} as const;
export type AiDigestEventType =
  (typeof AI_DIGEST_EVENTS)[keyof typeof AI_DIGEST_EVENTS];

export const AI_DIGEST_ACTIVITY_TYPES: readonly AiDigestEventType[] =
  Object.values(AI_DIGEST_EVENTS);

/** `data` of an `ai_digest.sent` event. */
export interface AiDigestSentEventData {
  digestId: string;
  done: number;
  stuck: number;
  waiting: number;
  /** Telegram chats it reached. */
  delivered: number;
}

/** `data` of an `ai_digest.skipped` event. */
export interface AiDigestSkippedEventData {
  reason: AiDigestSkipReason;
  message: string;
}

/** The activity item's title of a sent digest. */
export const aiDigestSentTitle = (counts: {
  done: number;
  stuck: number;
  waiting: number;
}): string =>
  `Daily digest: ${counts.done} done, ${counts.stuck} stuck, ${counts.waiting} waiting`;

/** The activity item's title of a skipped digest. */
export const aiDigestSkippedTitle = (reason: string | null): string =>
  reason === 'llm_cap_reached'
    ? 'Daily digest skipped: the AI provider reached its monthly cap'
    : reason === 'no_model'
      ? 'Daily digest skipped: no default AI model is set'
      : 'Daily digest skipped: the AI provider refused the call';

// ─── Summaries ──────────────────────────────────────────────────────────────

export const AI_SUMMARY_SUBJECTS = ['card', 'session'] as const;
export type AiSummarySubject = (typeof AI_SUMMARY_SUBJECTS)[number];

/** A BCP 47 primary language subtag: `en`, `ru`, `uk`. */
export const AI_LANGUAGE_PATTERN = /^[a-z]{2,3}$/;

/** The reader's language from a locale such as `ru-RU`; `en` when there is none. */
export const aiReaderLanguage = (locale: string | null | undefined): string => {
  const primary = (locale ?? '').split(/[-_]/)[0]?.toLowerCase() ?? '';
  return AI_LANGUAGE_PATTERN.test(primary) ? primary : 'en';
};

/** The longest summary stored, in characters. */
export const AI_SUMMARY_MAX = 4000;

/** `POST …/summary`. */
export interface AiSummaryRequest {
  /** The reader's language, `AI_LANGUAGE_PATTERN`. */
  language: string;
  /** Make it again even when the source has not changed. */
  regenerate?: boolean;
}

/** A card's or a session's summary, as `POST …/summary` answers it. */
export interface AiSummaryView {
  subject: AiSummarySubject;
  subjectId: string;
  language: string;
  text: string;
  provider: LlmProviderId;
  model: string;
  /** The call that made it, USD; a decimal string. */
  costUsd: string;
  /** Served from the cache: the source did not change, and no call was made. */
  cached: boolean;
  /** When the text was made. */
  createdAt: string;
}

/** Refusals of the summary routes, besides the gateway's `llm_*` codes. */
export type AiSummaryErrorCode =
  /** No default model is set (Admin › AI providers). */
  | 'summary_no_model'
  /** The project does not ship session content, or the session has none (ADR-0021). */
  | 'summary_no_session_content';
