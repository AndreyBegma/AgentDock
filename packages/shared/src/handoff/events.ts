import { z } from 'zod';
import { cardIdSchema } from '../protocol/commands/cards';
import { skillRunIdSchema } from '../protocol/commands/skills';
import {
  cardRestartModeSchema,
  HANDOFF_NOTE_FIT_ISSUE,
  handoffNoteFields,
  handoffNoteFits,
  handoffUpdatedBySchema,
  restartEstimateSchema,
} from './contracts';

/**
 * Context handoff's runner events (#449). They travel in the ordinary
 * `events` stream with `source: "runner"` — no new message type (the #445
 * and #447 precedent). `data.projectId` repeats the envelope's project so
 * the API matches the card or the run without a lookup — and checks it
 * against the row it finds. The `data` schemas are strict (C-183).
 */

export const HANDOFF_UPDATED_EVENT = 'handoff.updated';
export const ROUND_RESTART_EVENT = 'round.restart';
export const ROUND_WARMUP_EVENT = 'round.warmup';

/** What a note belongs to, as the runner names it (D1). */
export const handoffSubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('card'), cardId: cardIdSchema }),
  /** A design (`uiprofile`) or planner run. */
  z.strictObject({ kind: z.literal('run'), runId: skillRunIdSchema }),
]);
export type HandoffSubject = z.infer<typeof handoffSubjectSchema>;

/**
 * A note changed — written by the agent, by haiku, or applied from a
 * person's `card.handoff.set`. Sent **only** when the project ships content
 * (`watchedProjectSchema.shipContent`, D4, ADR-0021); otherwise the note
 * never leaves the machine. Carries the whole note, not a diff.
 */
export const handoffUpdatedDataSchema = z
  .strictObject({
    projectId: z.string().min(1),
    at: z.iso.datetime(),
    subject: handoffSubjectSchema,
    updatedBy: handoffUpdatedBySchema,
    ...handoffNoteFields,
  })
  .refine(handoffNoteFits, HANDOFF_NOTE_FIT_ISSUE);
export type HandoffUpdatedData = z.infer<typeof handoffUpdatedDataSchema>;

/**
 * D3: how a card round's session started, sent once when it launches.
 * `sessionId` is the session the round runs in: the card's session for
 * `resume` and `first`, a new one for `fresh` — the API then moves the
 * card to it, and `previousSessionId` (the session not resumed) stays on the
 * earlier round, so it can still be resumed.
 */
export const roundRestartDataSchema = z
  .strictObject({
    projectId: z.string().min(1),
    cardId: cardIdSchema,
    /** The round's run; the API resolves the round from it. */
    runId: skillRunIdSchema,
    at: z.iso.datetime(),
    mode: cardRestartModeSchema,
    /** Both estimates; `null` for `first`, which has nothing to compare. */
    estimate: restartEstimateSchema.nullable(),
    sessionId: z.uuid(),
    /** With `fresh` only. */
    previousSessionId: z.uuid().optional(),
  })
  .refine((d) => (d.mode === 'first') === (d.estimate === null), {
    message: 'estimate is null exactly for a first round',
    path: ['estimate'],
  })
  .refine((d) => (d.mode === 'fresh') === (d.previousSessionId !== undefined), {
    message: 'previousSessionId goes with mode: fresh',
    path: ['previousSessionId'],
  })
  .refine((d) => d.previousSessionId !== d.sessionId, {
    message: 'a fresh session is a new session',
    path: ['sessionId'],
  });
export type RoundRestartData = z.infer<typeof roundRestartDataSchema>;

/** Fits the `INTEGER` columns. */
const int32 = z.number().int().nonnegative().max(2_147_483_647);

/**
 * D9: the round's warm-up — input tokens and ms from its start to its first
 * file edit. Sent once, at that edit; a round that never edits sends none.
 */
export const roundWarmupDataSchema = z.strictObject({
  projectId: z.string().min(1),
  cardId: cardIdSchema,
  runId: skillRunIdSchema,
  at: z.iso.datetime(),
  tokens: int32,
  ms: int32,
});
export type RoundWarmupData = z.infer<typeof roundWarmupDataSchema>;

/** `data` schema of every Context handoff runner event type. */
export const handoffEventDataSchemas = {
  [HANDOFF_UPDATED_EVENT]: handoffUpdatedDataSchema,
  [ROUND_RESTART_EVENT]: roundRestartDataSchema,
  [ROUND_WARMUP_EVENT]: roundWarmupDataSchema,
} as const;

export type HandoffEventType = keyof typeof handoffEventDataSchemas;
export const HANDOFF_EVENT_TYPES = Object.keys(
  handoffEventDataSchemas,
) as HandoffEventType[];

export const isHandoffEventType = (type: string): type is HandoffEventType =>
  Object.hasOwn(handoffEventDataSchemas, type);
