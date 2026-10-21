import { z } from 'zod';
import {
  PREFIX_PARTS_MAX,
  prefixPartSchema,
  sha256Schema,
} from '../../prefix/contracts';
import { tokenSaverRunKindSchema } from '../../token-saver/contracts';

/**
 * The launch prefix's runner events (docs/specs/751 B1, B10), sent in the
 * ordinary `events` stream with `source: "runner"`. The envelope's project
 * names the project; `runId` is kept only when it is a run of that project,
 * else the event is dropped (B13).
 */

/** `type` of the event with a launch's prefix parts (B1). */
export const PREFIX_MEASURED_EVENT = 'prefix.measured';
/** `type` of the event for an overlay whose original changed (B10). */
export const PREFIX_OVERLAY_STALE_EVENT = 'prefix.overlay_stale';

/** `prefix.measured`: once per launch, in both arms. Parts unique by `(kind, name)`. */
export const prefixMeasuredDataSchema = z
  .strictObject({
    runId: z.string().min(1).max(64),
    launchKind: tokenSaverRunKindSchema,
    parts: z.array(prefixPartSchema).max(PREFIX_PARTS_MAX),
  })
  .refine(
    (d) =>
      new Set(d.parts.map((p) => `${p.kind}\u0000${p.name}`)).size ===
      d.parts.length,
    { message: 'parts must be unique by kind and name' },
  );
export type PrefixMeasuredData = z.infer<typeof prefixMeasuredDataSchema>;

/**
 * `prefix.overlay_stale` (B10): the original in the round's worktree hashed
 * to `sha256`, not the overlay's `originalSha256`, so the round launched with
 * the original.
 */
export const prefixOverlayStaleDataSchema = z.strictObject({
  runId: z.string().min(1).max(64),
  overlayId: z.string().min(1).max(64),
  sha256: sha256Schema,
});
export type PrefixOverlayStaleData = z.infer<
  typeof prefixOverlayStaleDataSchema
>;
