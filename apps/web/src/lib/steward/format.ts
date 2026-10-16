import {
  STEWARD_NUDGE_MAX_PER_ROUND,
  STEWARD_RESUME_MAX_PER_ROUND,
  STEWARD_SILENCE_MINUTES_MAX,
  STEWARD_SILENCE_MINUTES_MIN,
  type StewardActionRecord,
  type StewardDigestView,
  type StewardIncidentStatus,
  type StewardSettings,
  stewardActionCount,
  stewardDigestTimeSchema,
} from '@agentdock/shared';
import { ApiError, describeError } from '../api';

export function describeStewardError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403)
      return 'Only project administrators can change Steward.';
    if (error.status === 404)
      return 'That project was not found, or you are not a member of it.';
  }
  return describeError(error);
}

/** D8: the API refuses a closed, missing or foreign issue with a plain 422 and its message. */
export function describeIssueLinkError(error: unknown): string {
  if (error instanceof ApiError && error.status === 422) return error.message;
  return describeError(error);
}

export type IssueInput =
  | { ok: true; number: number | null }
  | { ok: false; message: string };

/** The Issue field: `''` unlinks, `12` or `#12` links, anything else is refused before the call. */
export function parseIssueInput(text: string): IssueInput {
  const raw = text.trim();
  if (raw === '') return { ok: true, number: null };
  const trimmed = raw.replace(/^#/, '');
  if (!/^\d{1,9}$/.test(trimmed) || Number(trimmed) <= 0) {
    return { ok: false, message: 'Enter an issue number, like 447.' };
  }
  return { ok: true, number: Number(trimmed) };
}

export const INCIDENT_STATUS_LABEL: Record<StewardIncidentStatus, string> = {
  open: 'Open',
  escalated: 'Needs you',
  resolved: 'Resolved',
};

export const INCIDENT_STATUS_TONE: Record<
  StewardIncidentStatus,
  'warn' | 'danger' | 'ok'
> = { open: 'warn', escalated: 'danger', resolved: 'ok' };

const ACTION_DONE: Record<StewardActionRecord['action'], string> = {
  nudge: 'Nudged',
  dismiss: 'Dismissed a dialog',
  resume: 'Resumed',
  hold_push: 'Held the push',
};

/** One action of an incident as a line: "Nudged 1/2", "Resumed 2/2 — failed", "Held the push — 2 commits to rewrite". */
export function actionLine(
  record: StewardActionRecord,
  history: readonly StewardActionRecord[],
): string {
  const upTo = history.slice(0, history.indexOf(record) + 1);
  const max =
    record.action === 'nudge'
      ? STEWARD_NUDGE_MAX_PER_ROUND
      : record.action === 'resume'
        ? STEWARD_RESUME_MAX_PER_ROUND
        : null;
  const count = stewardActionCount(upTo, record.action);
  const text = `${ACTION_DONE[record.action]}${max ? ` ${count}/${max}` : ''}`;
  const failed = record.result === 'failed' ? ' — failed' : '';
  return `${text}${failed}${record.detail ? ` — ${record.detail}` : ''}`;
}

export interface StewardForm {
  enabled: boolean;
  /** Text, so a half-typed number is not forced back. */
  silenceMinutes: string;
  digestTime: string;
  autoNudge: boolean;
  autoDismiss: boolean;
  autoResume: boolean;
  trailerGuard: boolean;
}

export const formOf = (s: StewardSettings): StewardForm => ({
  enabled: s.enabled,
  silenceMinutes: String(s.silenceMinutes),
  digestTime: s.digestTime,
  autoNudge: s.autoNudge,
  autoDismiss: s.autoDismiss,
  autoResume: s.autoResume,
  trailerGuard: s.trailerGuard,
});

export type FormResult =
  | { ok: true; settings: StewardSettings }
  | { ok: false; message: string };

/** The form as the body of PUT, or the sentence that says what to fix. */
export function settingsOf(form: StewardForm): FormResult {
  const text = form.silenceMinutes.trim();
  const minutes = Number(text);
  if (
    !/^\d+$/.test(text) ||
    minutes < STEWARD_SILENCE_MINUTES_MIN ||
    minutes > STEWARD_SILENCE_MINUTES_MAX
  ) {
    return {
      ok: false,
      message: `Silence threshold is a whole number of minutes, ${STEWARD_SILENCE_MINUTES_MIN}–${STEWARD_SILENCE_MINUTES_MAX}.`,
    };
  }
  if (!stewardDigestTimeSchema.safeParse(form.digestTime).success) {
    return { ok: false, message: 'Digest time is a time of day, like 09:00.' };
  }
  return {
    ok: true,
    settings: {
      enabled: form.enabled,
      silenceMinutes: minutes,
      digestTime: form.digestTime,
      autoNudge: form.autoNudge,
      autoDismiss: form.autoDismiss,
      autoResume: form.autoResume,
      trailerGuard: form.trailerGuard,
    },
  };
}

export const sameForm = (a: StewardForm, b: StewardForm): boolean =>
  a.enabled === b.enabled &&
  a.silenceMinutes.trim() === b.silenceMinutes.trim() &&
  a.digestTime === b.digestTime &&
  a.autoNudge === b.autoNudge &&
  a.autoDismiss === b.autoDismiss &&
  a.autoResume === b.autoResume &&
  a.trailerGuard === b.trailerGuard;

export const DIGEST_TRIGGER_LABEL: Record<
  StewardDigestView['trigger'],
  string
> = { daily: 'Daily digest', away_off: 'While you were away' };

/** "3 done · 1 stuck · 2 waiting on you" — nothing in a bucket is left out of the count, not the line. */
export function digestCounts(digest: StewardDigestView): string {
  return [
    `${digest.done.length} done`,
    `${digest.stuck.length} stuck`,
    `${digest.waiting.length} waiting on you`,
  ].join(' · ');
}

/** The digest has nothing to report in any bucket. */
export const digestIsQuiet = (digest: StewardDigestView): boolean =>
  digest.done.length === 0 &&
  digest.stuck.length === 0 &&
  digest.waiting.length === 0;
