import { z } from 'zod';
import { CAPTURE_RESULT_MAX_BYTES } from '../../board/capture-limits';
import { skillRunIdSchema } from '../commands/skills';

/**
 * Card capture events (issue #244 "Runner"). An extraction outlives the
 * `cards.extract` command that started it, so its end travels in the event
 * stream. `source: "runner"`; `data.projectId` repeats the envelope's project
 * so the API matches the run without a lookup.
 */

export const CAPTURE_EXTRACT_ERROR_MAX = 2000;

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

/**
 * Once, when the extraction ends. `result` is `claude -p`'s final result,
 * cut at `CAPTURE_RESULT_MAX_BYTES` with `resultTruncated` — which the API
 * then records as a `contract_violation` rather than parse half a block.
 * `ok: false` carries `error`: the CLI's error, a timeout, a missing profile.
 */
export const cardsExtractFinishedDataSchema = z
  .object({
    runId: skillRunIdSchema,
    projectId: z.string().min(1),
    ok: z.boolean(),
    at: z.iso.datetime(),
    exitCode: z.number().int().optional(),
    result: z
      .string()
      .refine((t) => utf8Bytes(t) <= CAPTURE_RESULT_MAX_BYTES, {
        message: `must be at most ${CAPTURE_RESULT_MAX_BYTES} bytes`,
      })
      .optional(),
    resultTruncated: z.boolean().default(false),
    error: z.string().min(1).max(CAPTURE_EXTRACT_ERROR_MAX).optional(),
  })
  .refine((d) => d.ok || d.error !== undefined, {
    message: 'a failed extraction carries error',
    path: ['error'],
  });
export type CardsExtractFinishedData = z.infer<
  typeof cardsExtractFinishedDataSchema
>;

/** `data` schema of every capture event type. */
export const captureEventDataSchemas = {
  'cards_extract.finished': cardsExtractFinishedDataSchema,
} as const;

export type CaptureEventType = keyof typeof captureEventDataSchemas;
export const CAPTURE_EVENT_TYPES = Object.keys(
  captureEventDataSchemas,
) as CaptureEventType[];

export const isCaptureEventType = (type: string): type is CaptureEventType =>
  Object.hasOwn(captureEventDataSchemas, type);
