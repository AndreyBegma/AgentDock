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
/**
 * #686 (ADR-0070): a result too large for one event travels in ordered
 * `plan_turn.result_chunk` events before `plan_turn.finished`. One chunk's
 * text, JSON-encoded, is at most this, so the event fits a batch…
 */
export const PLAN_TURN_RESULT_CHUNK_BYTES = 128 * 1024;
/** …and the whole result, chunked, at most this; the runner cuts the rest. */
export const PLAN_TURN_RESULT_TOTAL_MAX_BYTES = 2 * 1024 * 1024;
/** Chunks of one result: enough for the total even when escaping doubles it. */
export const PLAN_TURN_RESULT_CHUNKS_MAX = Math.ceil(
  (2 * PLAN_TURN_RESULT_TOTAL_MAX_BYTES) / PLAN_TURN_RESULT_CHUNK_BYTES,
);

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
 * #686: one ordered piece of a result over `PLAN_TURN_RESULT_MAX_BYTES`,
 * emitted before the turn's `plan_turn.finished`. The API joins pieces
 * `0 … resultChunks - 1` in `index` order.
 */
export const planTurnResultChunkDataSchema = turnRefSchema.extend({
  index: z
    .number()
    .int()
    .nonnegative()
    .max(PLAN_TURN_RESULT_CHUNKS_MAX - 1),
  text: z.string().refine((t) => utf8Bytes(t) <= PLAN_TURN_RESULT_CHUNK_BYTES, {
    message: `must be at most ${PLAN_TURN_RESULT_CHUNK_BYTES} bytes`,
  }),
});
export type PlanTurnResultChunkData = z.infer<
  typeof planTurnResultChunkDataSchema
>;

/**
 * Once, when the turn ends. `sessionId` is the session the turn ran in — for
 * a fork, the fork's. `resultText` is `claude -p`'s final result; it is cut at
 * `PLAN_TURN_RESULT_TOTAL_MAX_BYTES` with `resultTruncated`, which the API
 * then fails as a `contract_violation` rather than parse half a block. A
 * result that fits one event is `resultText`; a larger one (#686) went ahead
 * as `resultChunks` chunk events, and `resultText` is absent.
 */
export const planTurnFinishedDataSchema = turnRefSchema
  .extend({
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
    /** #686: how many `plan_turn.result_chunk` events hold the result. */
    resultChunks: z
      .number()
      .int()
      .positive()
      .max(PLAN_TURN_RESULT_CHUNKS_MAX)
      .optional(),
    /** Why a turn failed: the CLI's error, a timeout, a missing session. */
    error: z.string().max(PLAN_TURN_ERROR_MAX).optional(),
  })
  .refine((d) => d.resultText === undefined || d.resultChunks === undefined, {
    message: 'resultText and resultChunks are exclusive',
  });
export type PlanTurnFinishedData = z.infer<typeof planTurnFinishedDataSchema>;

/** `data` schema of every plan turn event type. */
export const planTurnEventDataSchemas = {
  'plan_turn.phase_changed': planTurnPhaseChangedDataSchema,
  'plan_turn.result_chunk': planTurnResultChunkDataSchema,
  'plan_turn.finished': planTurnFinishedDataSchema,
} as const;

export type PlanTurnEventType = keyof typeof planTurnEventDataSchemas;
export const PLAN_TURN_EVENT_TYPES = Object.keys(
  planTurnEventDataSchemas,
) as PlanTurnEventType[];

export const isPlanTurnEventType = (type: string): type is PlanTurnEventType =>
  Object.hasOwn(planTurnEventDataSchemas, type);

/** Bytes `text` takes as a JSON string in an event line, quotes excluded. */
export const jsonStringBytes = (text: string): number =>
  utf8Bytes(JSON.stringify(text)) - 2;

/**
 * #686: `text` in ordered pieces whose JSON-encoded size is at most
 * `PLAN_TURN_RESULT_CHUNK_BYTES` each, never split inside a surrogate pair.
 * Joined in order they give `text` back.
 */
export const chunkResultText = (
  text: string,
  maxBytes: number = PLAN_TURN_RESULT_CHUNK_BYTES,
): string[] => {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    // Each UTF-16 unit takes at least one byte, so this is an upper bound.
    let end = Math.min(text.length, start + maxBytes);
    for (;;) {
      const last = text.charCodeAt(end - 1);
      if (
        end < text.length &&
        end - start > 1 &&
        last >= 0xd800 &&
        last <= 0xdbff
      )
        end--;
      const size = jsonStringBytes(text.slice(start, end));
      if (size <= maxBytes) break;
      // Shrink in proportion, at least by one unit.
      end =
        start +
        Math.max(
          1,
          Math.min(
            end - start - 1,
            Math.floor(((end - start) * maxBytes) / size),
          ),
        );
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
};
