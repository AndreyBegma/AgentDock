import { z } from 'zod';
import { planTurnPhaseSchema } from '../../planner/types';
import { planIdSchema, planSessionIdSchema } from '../commands/planner';
import { skillRunIdSchema } from '../commands/skills';

/**
 * Plan turn events (docs/specs/172-planner.md "Protocol"). A turn outlives
 * the `plan.turn` command that started it, so its progress travels in the
 * event stream, as a skill run's does. `source: "runner"`; `data.projectId`
 * repeats the envelope's project so the API can match the turn without a
 * lookup. The runner does not parse the result (D17): it returns the text.
 */

/** An event batch is 256 KiB (spec 24 notes); the result text stays well under it. */
export const PLAN_TURN_RESULT_MAX_BYTES = 192 * 1024;
export const PLAN_TURN_ERROR_MAX = 2000;

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

const turnRefSchema = z.object({
  planId: planIdSchema,
  turnId: planIdSchema,
  runId: skillRunIdSchema,
  projectId: z.string().min(1),
});

export const planTurnTerminalPhaseSchema = z.enum([
  'succeeded',
  'failed',
  'cancelled',
]);
export type PlanTurnTerminalPhase = z.infer<typeof planTurnTerminalPhaseSchema>;

/** Every phase transition, `queued` included. */
export const planTurnPhaseChangedDataSchema = turnRefSchema.extend({
  phase: planTurnPhaseSchema,
  at: z.iso.datetime(),
});
export type PlanTurnPhaseChangedData = z.infer<
  typeof planTurnPhaseChangedDataSchema
>;

/**
 * Once, when the turn ends. `sessionId` is the session the turn ran in — for
 * a fork, the fork's. `resultText` is `claude -p`'s final result; it is cut at
 * `PLAN_TURN_RESULT_MAX_BYTES` with `resultTruncated`, which the API then
 * fails as a `contract_violation` rather than parse half a block.
 */
export const planTurnFinishedDataSchema = turnRefSchema.extend({
  phase: planTurnTerminalPhaseSchema,
  at: z.iso.datetime(),
  sessionId: planSessionIdSchema.optional(),
  exitCode: z.number().int().optional(),
  resultText: z
    .string()
    .refine((t) => utf8Bytes(t) <= PLAN_TURN_RESULT_MAX_BYTES, {
      message: `must be at most ${PLAN_TURN_RESULT_MAX_BYTES} bytes`,
    })
    .optional(),
  resultTruncated: z.boolean(),
  /** Why a turn failed: the CLI's error, a timeout, a missing session. */
  error: z.string().max(PLAN_TURN_ERROR_MAX).optional(),
});
export type PlanTurnFinishedData = z.infer<typeof planTurnFinishedDataSchema>;

/** `data` schema of every plan turn event type. */
export const planTurnEventDataSchemas = {
  'plan_turn.phase_changed': planTurnPhaseChangedDataSchema,
  'plan_turn.finished': planTurnFinishedDataSchema,
} as const;

export type PlanTurnEventType = keyof typeof planTurnEventDataSchemas;
export const PLAN_TURN_EVENT_TYPES = Object.keys(
  planTurnEventDataSchemas,
) as PlanTurnEventType[];

export const isPlanTurnEventType = (type: string): type is PlanTurnEventType =>
  Object.hasOwn(planTurnEventDataSchemas, type);
