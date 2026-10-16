import { z } from 'zod';
import { cardIdSchema } from '../protocol/commands/cards';
import { skillRunIdSchema } from '../protocol/commands/skills';
import {
  STEWARD_KIND_LABEL,
  STEWARD_NUDGE_MAX_PER_ROUND,
  STEWARD_RESUME_MAX_PER_ROUND,
  type StewardAction,
  stewardActionResultSchema,
  stewardActionSchema,
  stewardDialogIdSchema,
  stewardIncidentKindSchema,
  stewardPaneTailSchema,
  stewardReasonSchema,
  stewardSubjectKindSchema,
} from './contracts';

/**
 * Steward's events (#447 D2, D12, D13). Two travel from the runner in the
 * ordinary `events` stream with `source: "runner"` — no new message type
 * (the #445 precedent); four are recorded by the API itself
 * (`source: "api"`, ADR-0014) as an incident moves, and those are what
 * Activity shows.
 */

// The subject

/** What an observation or an action is about, as the runner names it. */
export const stewardSubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('card_round'),
    cardId: cardIdSchema,
    /** The round's run; the API resolves the round from it. */
    runId: skillRunIdSchema,
  }),
  z.strictObject({ kind: z.literal('run'), runId: skillRunIdSchema }),
  /** Observe-only (D5): no command takes it. */
  z.strictObject({
    kind: z.literal('fleet_slot'),
    slot: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._-]+$/),
  }),
]);
export type StewardSubject = z.infer<typeof stewardSubjectSchema>;

/** A subject Steward may act on: never a fleet slot (D5). */
export const stewardActableSubjectSchema = z.discriminatedUnion('kind', [
  stewardSubjectSchema.options[0],
  stewardSubjectSchema.options[1],
]);
export type StewardActableSubject = z.infer<typeof stewardActableSubjectSchema>;

// Runner → API

export const STEWARD_OBSERVED_EVENT = 'steward.observed';
export const STEWARD_ACTED_EVENT = 'steward.acted';

/**
 * The runner saw a stall: a pane signal at the next pane poll, or silence
 * past the project's threshold (D6). Sent once per change of `kind` or
 * `reason` for a subject, not on every poll. `reason` is the rule's line, or
 * haiku's for `unknown` (D3).
 *
 * D12: no pane or transcript text but `paneTail`, and `paneTail` only when
 * the project ships content (`watchedProjectSchema.shipContent`).
 */
export const stewardObservedDataSchema = z
  .object({
    projectId: z.string().min(1),
    at: z.iso.datetime(),
    subject: stewardSubjectSchema,
    kind: stewardIncidentKindSchema,
    reason: stewardReasonSchema,
    /** With `kind: 'dialog'` only, when the dialog is on the D11 list. */
    dialogId: stewardDialogIdSchema.optional(),
    paneTail: stewardPaneTailSchema.optional(),
  })
  .refine((d) => d.dialogId === undefined || d.kind === 'dialog', {
    message: 'dialogId goes with kind: dialog',
    path: ['dialogId'],
  });
export type StewardObservedData = z.infer<typeof stewardObservedDataSchema>;

/**
 * The runner performed a Steward action — every one, whether a command asked
 * for it (`nudge`, `dismiss`, `resume`) or the runner did it by itself
 * (`hold_push`, D7). The API appends it to the subject's open incident; this
 * event, not the command's result, is the record.
 */
export const stewardActedDataSchema = z.object({
  projectId: z.string().min(1),
  at: z.iso.datetime(),
  subject: stewardActableSubjectSchema,
  action: stewardActionSchema,
  result: stewardActionResultSchema,
  /** One line, e.g. "2 commits to rewrite"; never pane text. */
  detail: stewardReasonSchema.optional(),
});
export type StewardActedData = z.infer<typeof stewardActedDataSchema>;

/** `data` schema of every Steward runner event type. */
export const stewardEventDataSchemas = {
  [STEWARD_OBSERVED_EVENT]: stewardObservedDataSchema,
  [STEWARD_ACTED_EVENT]: stewardActedDataSchema,
} as const;

export type StewardEventType = keyof typeof stewardEventDataSchemas;
export const STEWARD_EVENT_TYPES = Object.keys(
  stewardEventDataSchemas,
) as StewardEventType[];

export const isStewardEventType = (type: string): type is StewardEventType =>
  Object.hasOwn(stewardEventDataSchemas, type);

// API-recorded (Activity, D13, D15)

export const STEWARD_INCIDENT_EVENTS = {
  opened: 'steward_incident.opened',
  acted: 'steward_incident.acted',
  escalated: 'steward_incident.escalated',
  /** D13: recovery — an Activity entry, never a push. */
  resolved: 'steward_incident.resolved',
} as const;
export type StewardIncidentEventType =
  (typeof STEWARD_INCIDENT_EVENTS)[keyof typeof STEWARD_INCIDENT_EVENTS];

/** Every Activity type Steward adds — the web's **Steward** filter (D15). */
export const STEWARD_ACTIVITY_TYPES: readonly StewardIncidentEventType[] =
  Object.values(STEWARD_INCIDENT_EVENTS);

/** `data` of every `steward_incident.*` event the API records. */
export const stewardIncidentEventDataSchema = z.object({
  incidentId: z.string().min(1),
  subjectKind: stewardSubjectKindSchema,
  subjectId: z.string().min(1),
  /** `C-12`, a run's title, a slot. */
  subjectLabel: z.string().min(1).max(200).optional(),
  /** The card's number, for the link to the Board. */
  cardNumber: z.number().int().positive().optional(),
  kind: stewardIncidentKindSchema,
  reason: stewardReasonSchema,
  /** `acted` only. */
  action: stewardActionSchema.optional(),
  result: stewardActionResultSchema.optional(),
  /** `acted` only: this action's attempt number on the incident, from 1. */
  attempt: z.number().int().positive().optional(),
});
export type StewardIncidentEventData = z.infer<
  typeof stewardIncidentEventDataSchema
>;

const ACTION_VERB: Record<StewardAction, [done: string, failed: string]> = {
  nudge: ['nudged', 'nudge'],
  dismiss: ['dismissed a dialog in', 'dismiss a dialog in'],
  resume: ['resumed', 'resume'],
  hold_push: ['held the push of', 'hold the push of'],
};

const ACTION_MAX: Record<StewardAction, number | null> = {
  nudge: STEWARD_NUDGE_MAX_PER_ROUND,
  dismiss: null,
  resume: STEWARD_RESUME_MAX_PER_ROUND,
  hold_push: null,
};

/** The Activity title of a `steward_incident.*` event. */
export const stewardIncidentTitle = (
  type: StewardIncidentEventType,
  data: Pick<
    StewardIncidentEventData,
    'subjectLabel' | 'kind' | 'reason' | 'action' | 'result' | 'attempt'
  >,
): string => {
  const subject = data.subjectLabel ?? 'A run';
  const kind = STEWARD_KIND_LABEL[data.kind];
  switch (type) {
    case STEWARD_INCIDENT_EVENTS.opened:
      return `${subject} stuck: ${kind} — ${data.reason}`;
    case STEWARD_INCIDENT_EVENTS.escalated:
      return `${subject} needs you: ${data.reason}`;
    case STEWARD_INCIDENT_EVENTS.resolved:
      return `${subject} recovered (${kind})`;
    case STEWARD_INCIDENT_EVENTS.acted: {
      if (!data.action) return `Steward acted on ${subject}`;
      const [done, failed] = ACTION_VERB[data.action];
      const max = ACTION_MAX[data.action];
      const attempt = data.attempt && max ? ` (${data.attempt}/${max})` : '';
      return data.result === 'failed'
        ? `Steward could not ${failed} ${subject}`
        : `Steward ${done} ${subject}${attempt}`;
    }
  }
};
