import { z } from 'zod';
import { boundedName, TEXT_NAME_MAX, TEXT_PATH_MAX } from './bounded';
import { slotNameSchema } from './commands/control';

/** Version of the event envelope (event-schema.md). */
export const EVENT_SCHEMA_VERSION = 1;

/** `seq` is assigned by the runner, starts at 1 and never repeats. */
export const seqSchema = z.number().int().positive();

/** A `seq` cursor: the highest contiguous seq persisted, `0` when nothing is. */
export const seqCursorSchema = z.number().int().nonnegative();

export const eventSourceSchema = z.enum([
  'code-sentinel',
  'runner',
  'otel',
  'transcript',
  'github',
  /** Parsed from Code Sentinel's markdown, the ADR-0002 fallback (spec 11). */
  'scraped',
  /** The `nautelle` Claude Code plugin's hooks (ADR-0020). */
  'hook',
]);
export type EventSource = z.infer<typeof eventSourceSchema>;

/**
 * `source` of an event the API records itself (ADR-0014). Deliberately not in
 * `eventSourceSchema`: a runner can never send it, so a row with this source
 * was written by the API.
 */
export const API_EVENT_SOURCE = 'api';

const eventFields = {
  v: z.literal(EVENT_SCHEMA_VERSION),
  ts: z.iso.datetime(),
  type: boundedName(TEXT_NAME_MAX),
  source: eventSourceSchema,
  project: z
    .object({
      repo: boundedName(TEXT_NAME_MAX),
      root: boundedName(TEXT_PATH_MAX),
    })
    .optional(),
  slot: slotNameSchema.optional(),
  issue: z.number().int().positive().optional(),
  session: z
    .object({
      runtime: boundedName(TEXT_NAME_MAX),
      id: boundedName(TEXT_NAME_MAX),
      name: boundedName(TEXT_NAME_MAX).optional(),
    })
    .optional(),
  /** Typed per `type` by the consumer; unknown types are stored raw. */
  data: z.unknown(),
};

/** An event on the wire: `seq` is always present. */
export const eventSchema = z.object({ ...eventFields, seq: seqSchema });
export type RunnerEvent = z.infer<typeof eventSchema>;

/** An event as Code Sentinel writes it, before the runner assigns `seq`. */
export const unsequencedEventSchema = z.object(eventFields);
export type UnsequencedEvent = z.infer<typeof unsequencedEventSchema>;

/** `data` of `runner.spool_truncated`: the range the spool cap dropped. */
export const spoolTruncatedDataSchema = z.object({
  fromSeq: seqSchema,
  toSeq: seqSchema,
  bytes: z.number().int().nonnegative(),
});
export type SpoolTruncatedData = z.infer<typeof spoolTruncatedDataSchema>;

export const SPOOL_TRUNCATED_EVENT = 'runner.spool_truncated';
