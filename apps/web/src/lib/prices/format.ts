import type {
  PriceSource,
  PriceTestRequest,
  RecomputeStatus,
} from '@nautelle/shared';

export type TokenBucket = keyof NonNullable<PriceTestRequest['tokens']>;

/** The token buckets the test calculator takes, in the order it shows them. */
export const TEST_BUCKETS = [
  'input',
  'output',
  'cacheRead',
  'cacheWrite5m',
  'cacheWrite1h',
  'reasoning',
] as const satisfies readonly TokenBucket[];

/** Rule R5: a bucket's field name is not a label. */
export const BUCKET_LABEL: Record<(typeof TEST_BUCKETS)[number], string> = {
  input: 'Input',
  output: 'Output',
  cacheRead: 'Cache read',
  cacheWrite5m: 'Cache write (5 min)',
  cacheWrite1h: 'Cache write (1 hour)',
  reasoning: 'Reasoning',
};

/** Where a price version came from. */
export const SOURCE_LABEL: Record<PriceSource, string> = {
  'langfuse-seed': 'Seeded from Langfuse',
  admin: 'Edited by an admin',
};

/** A re-price job's state. */
export const REPRICE_STATUS_LABEL: Record<RecomputeStatus, string> = {
  queued: 'Waiting to start',
  running: 'Re-pricing',
  done: 'Done',
  failed: 'Failed',
};

/** Creates price version 1; run where the API's database is reachable. */
export const PRICES_SEED_COMMAND = 'bun run db:seed';

/** Rule R1: why the version-bound actions are off before the first version. */
export const NO_VERSION_REASON =
  'Needs a price version first — see “No price version yet” below.';
