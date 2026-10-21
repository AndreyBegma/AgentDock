import {
  type PrefixMeasuredData,
  type PrefixOverlayStaleData,
  prefixMeasuredDataSchema,
  prefixOverlayStaleDataSchema,
} from '@nautelle/shared/protocol';
import { z } from 'zod';

/**
 * #751 B1, B10: what a launch writes into its run dir for the daemon to send
 * — the parts and the stale overlays — as the filter writes its stats rows
 * (#445 amendment 5). The stats reader sends it once, as `prefix.measured`
 * and one `prefix.overlay_stale` per stale overlay.
 */
export const PREFIX_MEASURED_FILE = 'prefix-measured.json';
/** Beside it once it is in the spool: it is never sent twice. */
export const PREFIX_MEASURED_SENT_FILE = 'prefix-measured.sent';

export const prefixRecordSchema = z.object({
  measured: prefixMeasuredDataSchema,
  stale: z.array(prefixOverlayStaleDataSchema).max(64),
});

export interface PrefixRecord {
  measured: PrefixMeasuredData;
  stale: PrefixOverlayStaleData[];
}
