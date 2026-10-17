import { z } from 'zod';

/**
 * Steward (issue #447, ADR-0040): detects stuck agent work, performs the safe
 * actions itself within limits, and tells the person in one line. These are
 * the contracts every slot builds on — the incident vocabulary, the project
 * setting, the limits and fixed texts, and the views the API serves to the
 * card, Activity, Overview and settings. The runner events live in
 * `./events`, the commands in `protocol/commands/steward`.
 *
 * This module imports nothing from `protocol`: `protocol` imports it.
 */

// The vocabulary (spec "Data / Schema")

/**
 * Mirrors the Prisma enum `StewardSubjectKind`. Steward acts on `card_round`
 * and `run`; a `fleet_slot` is observe-only (D5, ADR-0005) — no command
 * schema accepts it.
 */
export const STEWARD_SUBJECT_KINDS = [
  'card_round',
  'run',
  'fleet_slot',
] as const;
export type StewardSubjectKind = (typeof STEWARD_SUBJECT_KINDS)[number];
export const stewardSubjectKindSchema = z.enum(STEWARD_SUBJECT_KINDS);

/** Mirrors the Prisma enum `StewardIncidentKind`. */
export const STEWARD_INCIDENT_KINDS = [
  /** An API or network error, or an interrupted response, in the pane (D9). */
  'api_error',
  /** A Claude Code modal dialog (D11). */
  'dialog',
  /** A permission prompt — never answered, escalates at once (D11). */
  'permission_prompt',
  /** The quota banner. */
  'quota',
  /** No hook event and no live background task for the threshold (D6). */
  'silent',
  /** The card's tmux session is gone (D10). */
  'dead_session',
  /** A card commit carries a Claude attribution trailer (D7). */
  'trailer',
  /** No rule matched; the reason is haiku's one line (D3). */
  'unknown',
] as const;
export type StewardIncidentKind = (typeof STEWARD_INCIDENT_KINDS)[number];
export const stewardIncidentKindSchema = z.enum(STEWARD_INCIDENT_KINDS);

/**
 * Mirrors the Prisma enum `StewardIncidentStatus`. `escalated` is an open
 * incident a person has been told about; `resolved` is closed (D13).
 */
export const STEWARD_INCIDENT_STATUSES = [
  'open',
  'resolved',
  'escalated',
] as const;
export type StewardIncidentStatus = (typeof STEWARD_INCIDENT_STATUSES)[number];
export const stewardIncidentStatusSchema = z.enum(STEWARD_INCIDENT_STATUSES);

/**
 * What Steward did about an incident. `nudge`, `dismiss` and `resume` are the
 * D9–D11 commands; `hold_push` is the trailer guard withholding a card's
 * push (D7), which the runner does by itself.
 */
export const STEWARD_ACTIONS = [
  'nudge',
  'dismiss',
  'resume',
  'hold_push',
] as const;
export type StewardAction = (typeof STEWARD_ACTIONS)[number];
export const stewardActionSchema = z.enum(STEWARD_ACTIONS);

export const STEWARD_ACTION_RESULTS = ['ok', 'failed'] as const;
export type StewardActionResult = (typeof STEWARD_ACTION_RESULTS)[number];
export const stewardActionResultSchema = z.enum(STEWARD_ACTION_RESULTS);

/** The notification kind of an escalated incident (D13). */
export const STEWARD_NOTIFICATION_KIND = 'steward.incident';

// Limits and fixed texts (D9–D12)

/** D9: nudges per round — the first at once, the second after the delay. */
export const STEWARD_NUDGE_MAX_PER_ROUND = 2;
/** D9: the second nudge waits this long after the first. */
export const STEWARD_NUDGE_REPEAT_DELAY_MS = 2 * 60_000;
/** D10: automatic resumes per round. */
export const STEWARD_RESUME_MAX_PER_ROUND = 2;
/** A reason is one line of at most this many characters (D12). */
export const STEWARD_REASON_MAX = 200;
/** A pane tail, sent only when the project ships content (D12), in bytes. */
export const STEWARD_PANE_TAIL_MAX_BYTES = 4096;
/** At most this many action records on one incident. */
export const STEWARD_ACTIONS_MAX = 32;

/** D9: the only text a nudge types. */
export const STEWARD_NUDGE_TEXT =
  'The previous response was cut off by an API/network error. Continue from where you stopped.';

/** D10: the only prompt a resumed session gets. */
export const STEWARD_RESUME_TEXT =
  'The session was restarted after a crash. Continue from where you stopped.';

/**
 * D11: the dialogs Steward may dismiss — the `name`s of the runner's #435
 * list (`apps/runner/src/cards/dialogs.ts`, `KNOWN_DIALOGS`). A dialog that is
 * not here is never answered.
 */
export const STEWARD_DIALOG_IDS = ['teach-auto-mode'] as const;
export type StewardDialogId = (typeof STEWARD_DIALOG_IDS)[number];
export const stewardDialogIdSchema = z.enum(STEWARD_DIALOG_IDS);

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

/** One line, never empty, at most `STEWARD_REASON_MAX` characters. */
export const stewardReasonSchema = z
  .string()
  .min(1)
  .max(STEWARD_REASON_MAX)
  .refine((t) => !/[\r\n]/.test(t) && !t.includes('\u0000'), {
    message: 'must be one line',
  });

/** The pane's last lines, at most `STEWARD_PANE_TAIL_MAX_BYTES`. */
export const stewardPaneTailSchema = z
  .string()
  .min(1)
  .refine((t) => !t.includes('\u0000'), { message: 'must not contain NUL' })
  .refine((t) => utf8Bytes(t) <= STEWARD_PANE_TAIL_MAX_BYTES, {
    message: `must be at most ${STEWARD_PANE_TAIL_MAX_BYTES} bytes`,
  });

/** One element of `steward_incidents.actions`. */
export const stewardActionRecordSchema = z.strictObject({
  action: stewardActionSchema,
  at: z.iso.datetime(),
  result: stewardActionResultSchema,
  /** One line, e.g. "2 commits to rewrite"; never pane text. */
  detail: stewardReasonSchema.optional(),
});
export type StewardActionRecord = z.infer<typeof stewardActionRecordSchema>;

export const stewardActionRecordsSchema = z
  .array(stewardActionRecordSchema)
  .max(STEWARD_ACTIONS_MAX);

/** How many times `action` was attempted, whatever its result. */
export const stewardActionCount = (
  actions: readonly StewardActionRecord[],
  action: StewardAction,
): number => actions.filter((a) => a.action === action).length;

// The setting (D16)

export const STEWARD_SILENCE_MINUTES_MIN = 1;
export const STEWARD_SILENCE_MINUTES_MAX = 240;

/** `HH:MM`, 24-hour, in the person's timezone (D14). */
export const stewardDigestTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM');

/** The setting as the API stores it (`steward_settings`, D16). */
export const stewardSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  /** D6: minutes without a hook event or a live background task. */
  silenceMinutes: z
    .number()
    .int()
    .min(STEWARD_SILENCE_MINUTES_MIN)
    .max(STEWARD_SILENCE_MINUTES_MAX),
  digestTime: stewardDigestTimeSchema,
  autoNudge: z.boolean(),
  autoDismiss: z.boolean(),
  autoResume: z.boolean(),
  trailerGuard: z.boolean(),
});
export type StewardSettings = z.infer<typeof stewardSettingsSchema>;

/** A project without a `steward_settings` row (D16). */
export const STEWARD_DEFAULTS: StewardSettings = {
  enabled: true,
  silenceMinutes: 10,
  digestTime: '09:00',
  autoNudge: true,
  autoDismiss: true,
  autoResume: true,
  trailerGuard: true,
};

/** `GET /projects/:id/steward`. */
export interface StewardSettingsView extends StewardSettings {
  /** `null` when the project has no row (the defaults apply). */
  updatedAt: string | null;
}

/** `PUT /projects/:id/steward` (admin). */
export type UpdateStewardSettingsBody = StewardSettings;

/**
 * What the runner needs of the setting, on each watched project
 * (`watchedProjectSchema.steward`): whether to observe at all, the silence
 * threshold it measures against the hooks and background tasks it sees, and
 * the trailer guard it applies by itself on push. Nudge, dismiss and resume
 * are API decisions sent as commands, so their switches stay on the API.
 */
export const stewardRunnerConfigSchema = z.strictObject({
  enabled: z.boolean(),
  silenceMinutes: stewardSettingsSchema.shape.silenceMinutes,
  trailerGuard: z.boolean(),
});
export type StewardRunnerConfig = z.infer<typeof stewardRunnerConfigSchema>;

export const stewardRunnerConfigOf = (
  settings: StewardSettings,
): StewardRunnerConfig => ({
  enabled: settings.enabled,
  silenceMinutes: settings.silenceMinutes,
  trailerGuard: settings.trailerGuard,
});

// The trailer guard (D7)

/**
 * The attribution lines that stop a card's push. Matched per line and
 * case-insensitively, as git trailers are written either way.
 */
export const STEWARD_TRAILER_PATTERNS: readonly RegExp[] = [
  /^\s*Co-Authored-By:\s*Claude\b/im,
  /^\s*Claude-Session:/im,
  /Generated with \[?Claude Code\]?/i,
];

/** Whether a commit message carries a Claude attribution trailer (D7). */
export const hasClaudeTrailer = (message: string): boolean =>
  STEWARD_TRAILER_PATTERNS.some((pattern) => pattern.test(message));

// The issue link (D8)

const ISSUE_LINK_PATTERN = /\b(?:Closes|GitHub issue:)\s*#(\d{1,9})\b/i;

/**
 * D8: the issue a card's text names with `Closes #n` or `GitHub issue: #n` —
 * the link the sheet suggests; `null` when it names none. The first match
 * wins. A suggestion only: the API still checks the issue is open.
 */
export const suggestIssueLink = (text: string): number | null => {
  const match = ISSUE_LINK_PATTERN.exec(text);
  if (!match) return null;
  const n = Number(match[1]);
  return n > 0 ? n : null;
};

// The views (D13–D15)

/** One incident, as Activity, the card sheet and the API's list serve it. */
export interface StewardIncidentView {
  id: string;
  projectId: string;
  subjectKind: StewardSubjectKind;
  /**
   * `card_round`: the `board_card_rounds.id`; `run`: the `runs.id`;
   * `fleet_slot`: the slot name.
   */
  subjectId: string;
  /** What a person reads for the subject: `C-12`, a skill's title, a slot. */
  subjectLabel: string | null;
  kind: StewardIncidentKind;
  reason: string;
  actions: StewardActionRecord[];
  status: StewardIncidentStatus;
  openedAt: string;
  resolvedAt: string | null;
}

/** At most this many incidents in one `GET …/steward/incidents` page. */
export const STEWARD_INCIDENTS_PAGE_MAX = 200;

/**
 * D15: the chip on a card face while an incident of its latest round is
 * open or escalated (`BoardCardView.steward`).
 */
export interface StewardCardChip {
  incidentId: string;
  kind: StewardIncidentKind;
  status: Exclude<StewardIncidentStatus, 'resolved'>;
  /** The incident's actions, oldest first — the chip counts them. */
  actions: StewardActionRecord[];
}

export const STEWARD_KIND_LABEL: Record<StewardIncidentKind, string> = {
  api_error: 'API error',
  dialog: 'dialog',
  permission_prompt: 'permission prompt',
  quota: 'quota',
  silent: 'silent',
  dead_session: 'session ended',
  trailer: 'Claude trailer',
  unknown: 'unknown',
};

const actionPhrase = (
  chip: Pick<StewardCardChip, 'actions'>,
  last: StewardAction,
): string => {
  switch (last) {
    case 'nudge':
      return `nudged ${stewardActionCount(chip.actions, 'nudge')}/${STEWARD_NUDGE_MAX_PER_ROUND}`;
    case 'resume':
      return `resumed ${stewardActionCount(chip.actions, 'resume')}/${STEWARD_RESUME_MAX_PER_ROUND}`;
    case 'dismiss':
      return 'dismissed dialog';
    case 'hold_push':
      return 'push held';
  }
};

/**
 * D15: the chip's text — `Stuck: API error · nudged 1/2`. An escalated
 * incident ends with `needs you`.
 */
export const stewardChipLabel = (
  chip: Pick<StewardCardChip, 'kind' | 'status' | 'actions'>,
): string => {
  const parts = [`Stuck: ${STEWARD_KIND_LABEL[chip.kind]}`];
  const last = chip.actions.at(-1);
  if (last) parts.push(actionPhrase(chip, last.action));
  if (chip.status === 'escalated') parts.push('needs you');
  return parts.join(' · ');
};

// The digest (D14)

/** What produced a digest: the daily schedule, or away mode switched off. */
export const STEWARD_DIGEST_TRIGGERS = ['daily', 'away_off'] as const;
export type StewardDigestTrigger = (typeof STEWARD_DIGEST_TRIGGERS)[number];

/** A line of the digest; `url` opens the card, PR or slot when there is one. */
export interface StewardDigestItem {
  label: string;
  title: string;
  /** Stuck and waiting items: why, in one line. */
  reason: string | null;
  url: string | null;
}

/**
 * `GET /projects/:id/steward/digest/latest` and the Telegram message (D14).
 * `prose` is haiku's summary; `null` when the runner was offline and the
 * template was used.
 */
export interface StewardDigestView {
  id: string;
  projectId: string;
  trigger: StewardDigestTrigger;
  createdAt: string;
  /** The period the digest covers, ISO. */
  from: string;
  to: string;
  prose: string | null;
  done: StewardDigestItem[];
  stuck: StewardDigestItem[];
  waiting: StewardDigestItem[];
  /** Spend over the period, a decimal string as every `costUsd`. */
  spendUsd: string;
}
