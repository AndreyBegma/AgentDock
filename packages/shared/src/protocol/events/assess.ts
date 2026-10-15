import { z } from 'zod';
import {
  CARD_ASSESS_ERROR_MAX,
  CARD_ASSESS_RESULT_MAX_BYTES,
} from '../../assess/limits';
import { skillRunIdSchema } from '../commands/skills';

/**
 * Card assessment events (issue #322 D5). An assessment outlives the
 * `card.assess` command that started it, so its end travels in the event
 * stream. `source: "runner"`; `data.projectId` repeats the envelope's project
 * so the API matches the run without a lookup.
 */

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

/**
 * Once, when the run ends. `result` is `claude -p`'s final result, cut at
 * `CARD_ASSESS_RESULT_MAX_BYTES` with `resultTruncated` — which the API treats
 * as out of contract rather than parse half an answer. `ok: false` carries
 * `error`: the CLI's error, a timeout, a missing profile.
 */
export const cardAssessFinishedDataSchema = z
  .object({
    runId: skillRunIdSchema,
    projectId: z.string().min(1),
    ok: z.boolean(),
    at: z.iso.datetime(),
    exitCode: z.number().int().optional(),
    result: z
      .string()
      .refine((t) => utf8Bytes(t) <= CARD_ASSESS_RESULT_MAX_BYTES, {
        message: `must be at most ${CARD_ASSESS_RESULT_MAX_BYTES} bytes`,
      })
      .optional(),
    resultTruncated: z.boolean().default(false),
    error: z.string().min(1).max(CARD_ASSESS_ERROR_MAX).optional(),
  })
  .refine((d) => d.ok || d.error !== undefined, {
    message: 'a failed run carries error',
    path: ['error'],
  });
export type CardAssessFinishedData = z.infer<
  typeof cardAssessFinishedDataSchema
>;

/** `data` schema of every assessment event type. */
export const assessEventDataSchemas = {
  'card_assess.finished': cardAssessFinishedDataSchema,
} as const;

export type AssessEventType = keyof typeof assessEventDataSchemas;
export const ASSESS_EVENT_TYPES = Object.keys(
  assessEventDataSchemas,
) as AssessEventType[];

export const isAssessEventType = (type: string): type is AssessEventType =>
  Object.hasOwn(assessEventDataSchemas, type);
