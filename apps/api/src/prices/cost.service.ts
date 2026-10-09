import type { ModelPriceInput, PriceTier } from '@agentdock/shared';
import type { TokenBuckets } from '@agentdock/shared/protocol';
import { Injectable } from '@nestjs/common';
import type { CostSource, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { type CompiledPrice, compilePrices, priceRequest } from './pricing';

type Db = Prisma.TransactionClient | PrismaService;

/** The cost columns of `llm_requests` (spec 12 names; spec 13 D6). */
export interface CostFields {
  /** null: unpriced — no model price matches, or no price version exists. */
  costUsd: Prisma.Decimal | null;
  /** `price_versions.number` priced with (or tried, when unpriced). */
  priceVersion: number | null;
  costSource: CostSource | null;
}

/** Prices requests with one price version. */
export class Pricer {
  constructor(
    readonly version: number | null,
    private readonly prices: CompiledPrice[],
  ) {}

  price(model: string, tokens: TokenBuckets): CostFields {
    const priced = priceRequest(this.prices, model, tokens);
    return {
      costUsd: priced?.costUsd ?? null,
      priceVersion: this.version,
      costSource: priced ? 'computed' : null,
    };
  }
}

export const toModelPrice = (row: {
  modelName: string;
  matchPattern: string;
  priority: number;
  tiers: Prisma.JsonValue;
}): ModelPriceInput => ({
  modelName: row.modelName,
  matchPattern: row.matchPattern,
  priority: row.priority,
  // Written only through the validated DTO or the converter.
  tiers: row.tiers as unknown as PriceTier[],
});

/**
 * Computes request cost (spec 13 D6). The compiled current version is cached
 * and re-checked against the newest version number on every `current()` call —
 * once per ingest batch.
 */
@Injectable()
export class CostService {
  private cached: { id: string; pricer: Pricer } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** A pricer for the current (newest) version; one that prices nothing when none exists. */
  async current(db: Db = this.prisma): Promise<Pricer> {
    const head = await db.priceVersion.findFirst({
      orderBy: { number: 'desc' },
      select: { id: true },
    });
    if (!head) return new Pricer(null, []);
    if (this.cached?.id === head.id) return this.cached.pricer;
    const pricer = await this.forVersion(head.id, db);
    this.cached = { id: head.id, pricer };
    return pricer;
  }

  /** A pricer for one version, e.g. the one a recompute names. */
  async forVersion(versionId: string, db: Db = this.prisma): Promise<Pricer> {
    const version = await db.priceVersion.findUniqueOrThrow({
      where: { id: versionId },
      select: {
        number: true,
        models: {
          select: {
            modelName: true,
            matchPattern: true,
            priority: true,
            tiers: true,
          },
        },
      },
    });
    return new Pricer(
      version.number,
      compilePrices(version.models.map(toModelPrice)),
    );
  }
}
