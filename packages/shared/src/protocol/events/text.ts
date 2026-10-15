import { z } from 'zod';
import { TEXT_ERROR_MAX, TEXT_RESULT_MAX_BYTES } from '../../text/limits';
import { skillRunIdSchema } from '../commands/skills';

/**
 * Text normalization events (issue #271 "Runner"). A translation outlives the
 * `text.normalize` command that started it, so its end travels in the event
 * stream. `source: "runner"`; `data.projectId` repeats the envelope's project
 * so the API matches the run without a lookup.
 */

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

/**
 * Once, when the run ends. `result` is `claude -p`'s final result, cut at
 * `TEXT_RESULT_MAX_BYTES` with `resultTruncated` — which the API records as
 * a `contract_violation` rather than parse half a block. `ok: false` carries
 * `error`: the CLI's error, a timeout, a missing profile.
 */
export const textNormalizeFinishedDataSchema = z
  .object({
    runId: skillRunIdSchema,
    projectId: z.string().min(1),
    ok: z.boolean(),
    at: z.iso.datetime(),
    exitCode: z.number().int().optional(),
    result: z
      .string()
      .refine((t) => utf8Bytes(t) <= TEXT_RESULT_MAX_BYTES, {
        message: `must be at most ${TEXT_RESULT_MAX_BYTES} bytes`,
      })
      .optional(),
    resultTruncated: z.boolean().default(false),
    error: z.string().min(1).max(TEXT_ERROR_MAX).optional(),
  })
  .refine((d) => d.ok || d.error !== undefined, {
    message: 'a failed run carries error',
    path: ['error'],
  });
export type TextNormalizeFinishedData = z.infer<
  typeof textNormalizeFinishedDataSchema
>;

/** `data` schema of every text event type. */
export const textEventDataSchemas = {
  'text_normalize.finished': textNormalizeFinishedDataSchema,
} as const;

export type TextEventType = keyof typeof textEventDataSchemas;
export const TEXT_EVENT_TYPES = Object.keys(
  textEventDataSchemas,
) as TextEventType[];

export const isTextEventType = (type: string): type is TextEventType =>
  Object.hasOwn(textEventDataSchemas, type);
