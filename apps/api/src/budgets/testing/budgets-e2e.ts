import type { RunnerEvent } from '@nautelle/shared/protocol';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../database/prisma.service';
import {
  convertLangfusePrices,
  type LangfuseConversion,
} from '../../prices/langfuse';
import { readLangfuseSnapshot } from '../../prices/seed-prices';
import { Events } from '../../usage/testing/usage-e2e';

/** Seeded Sonnet input price is $3 / MTok: 500 000 input tokens cost $1.50. */
export const SONNET = 'claude-sonnet-4-5-20250929';
export const UNPRICED_MODEL = 'acme-unknown-model-1';
export const DOLLAR_AND_A_HALF = { input: 500_000 };

let snapshot: LangfuseConversion['prices'] | undefined;

/**
 * #899: a price version with only the snapshot prices of `models` — the figures
 * `seedPrices` gives them, without inserting the ~180 models a test never
 * reaches (and the ingest then compiles).
 */
export const seedSnapshotPrices = (
  prisma: PrismaService,
  models: readonly string[] = [SONNET],
) => {
  snapshot ??= convertLangfusePrices(readLangfuseSnapshot()).prices;
  const prices = snapshot.filter((p) => models.includes(p.modelName));
  if (prices.length !== models.length) {
    throw new Error(`not in the Langfuse snapshot: ${models.join(', ')}`);
  }
  return prisma.priceVersion.create({
    data: {
      number: 1,
      source: 'langfuse_seed',
      note: 'e2e: snapshot prices of the models the test spends on',
      models: {
        create: prices.map((p) => ({
          modelName: p.modelName,
          matchPattern: p.matchPattern,
          priority: p.priority,
          tiers: p.tiers as unknown as Prisma.InputJsonValue,
        })),
      },
    },
  });
};

/** Session fixtures on one runner, as #12 would see them. */
export class Feed extends Events {
  /** A session at `cwd`, correlated to `projectId` (and `slot`) when given. */
  session(
    id: string,
    cwd: string,
    ts: string,
    extra: { projectId?: string; slot?: string; parent?: string } = {},
  ): RunnerEvent {
    return this.next(
      'session.observed',
      id,
      {
        cwd,
        startedAt: ts,
        parsed: true,
        ...(extra.projectId ? { projectId: extra.projectId } : {}),
        ...(extra.slot ? { slot: extra.slot } : {}),
        ...(extra.parent ? { parent: { sessionId: extra.parent } } : {}),
      },
      ts,
    );
  }

  /** A $1.50 request (seeded prices), or an unpriced one. */
  spend(sessionId: string, requestId: string, ts: string, priced = true) {
    return this.request(
      sessionId,
      requestId,
      priced ? SONNET : UNPRICED_MODEL,
      DOLLAR_AND_A_HALF,
      ts,
    );
  }
}
