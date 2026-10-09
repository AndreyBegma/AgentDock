import type {
  CurrentPricesResponse,
  ModelPriceInput,
  PriceSource,
  PriceTestResponse,
  PriceVersionListResponse,
  PriceVersionSummary,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { usageError } from '../usage/usage-error';
import { toModelPrice } from './cost.service';
import type { CreatePriceVersionDto, PriceTestDto } from './dto';
import { compilePattern, compilePrices, priceRequest } from './pricing';

/** Serializes version creation: each takes the next `number`. */
const VERSION_LOCK = 13_014;

const versionSelect = {
  id: true,
  number: true,
  source: true,
  note: true,
  createdAt: true,
  createdBy: { select: { id: true, email: true } },
  _count: { select: { models: true } },
} as const satisfies Prisma.PriceVersionSelect;

type VersionRow = Prisma.PriceVersionGetPayload<{
  select: typeof versionSelect;
}>;

const toSummary = (row: VersionRow): PriceVersionSummary => ({
  id: row.id,
  number: row.number,
  source: (row.source === 'langfuse_seed'
    ? 'langfuse-seed'
    : 'admin') satisfies PriceSource,
  note: row.note,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
  models: row._count.models,
});

const modelSelect = {
  modelName: true,
  matchPattern: true,
  priority: true,
  tiers: true,
} as const;

/** Refuses a model price the pricer could not use (D3): a bad regex, not exactly one default tier. */
const checkModelPrice = (price: ModelPriceInput): void => {
  try {
    compilePattern(price.matchPattern);
  } catch {
    throw usageError(
      400,
      'invalid_price',
      `${price.modelName}: matchPattern is not a valid regular expression`,
    );
  }
  const defaults = price.tiers.filter((t) => t.isDefault).length;
  if (defaults !== 1) {
    throw usageError(
      400,
      'invalid_price',
      `${price.modelName}: needs exactly one default tier, has ${defaults}`,
    );
  }
  const names = new Set(price.tiers.map((t) => t.name));
  if (names.size !== price.tiers.length) {
    throw usageError(
      400,
      'invalid_price',
      `${price.modelName}: tier names must be unique`,
    );
  }
};

/** Copies only the fields of a model price, dropping anything a DTO class adds. */
const plain = (p: ModelPriceInput): ModelPriceInput => ({
  modelName: p.modelName,
  matchPattern: p.matchPattern,
  priority: p.priority,
  tiers: p.tiers.map((t) => ({
    name: t.name,
    isDefault: t.isDefault,
    conditions: t.conditions.map((c) => ({
      bucket: c.bucket,
      op: c.op,
      value: c.value,
    })),
    prices: { ...t.prices },
  })),
});

/** The price table (spec 13 D2–D4): read, versioned edits, the pattern tester. */
@Injectable()
export class PricesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async current(): Promise<CurrentPricesResponse> {
    const head = await this.prisma.priceVersion.findFirst({
      orderBy: { number: 'desc' },
      select: { ...versionSelect, models: { select: modelSelect } },
    });
    if (!head) return { version: null, models: [] };
    const { models, ...version } = head;
    return {
      version: toSummary(version),
      models: models
        .map(toModelPrice)
        .sort(
          (a, b) =>
            a.priority - b.priority || a.modelName.localeCompare(b.modelName),
        ),
    };
  }

  async versions(): Promise<PriceVersionListResponse> {
    const rows = await this.prisma.priceVersion.findMany({
      orderBy: { number: 'desc' },
      select: versionSelect,
    });
    return { versions: rows.map(toSummary) };
  }

  /**
   * A new version cloned from the current one with `remove` and then `upsert`
   * applied (D2). Earlier versions and every stored cost stay as they are.
   */
  async createVersion(
    dto: CreatePriceVersionDto,
    adminId: string,
    ctx: AuditContext,
  ): Promise<PriceVersionSummary> {
    const upserts = dto.upsert.map(plain);
    for (const price of upserts) checkModelPrice(price);
    const upsertNames = upserts.map((p) => p.modelName);
    if (new Set(upsertNames).size !== upsertNames.length) {
      throw usageError(400, 'invalid_price', 'upsert names a model twice');
    }

    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${VERSION_LOCK}::int, 0)`;
      const head = await tx.priceVersion.findFirst({
        orderBy: { number: 'desc' },
        select: { number: true, models: { select: modelSelect } },
      });
      const models = new Map(
        (head?.models ?? []).map((m) => [m.modelName, toModelPrice(m)]),
      );
      const missing = dto.remove.filter((name) => !models.has(name));
      if (missing.length > 0) {
        throw usageError(
          400,
          'invalid_price',
          `remove names models not in the current version: ${missing.join(', ')}`,
        );
      }
      for (const name of dto.remove) models.delete(name);
      for (const price of upserts) models.set(price.modelName, price);

      return tx.priceVersion.create({
        data: {
          number: (head?.number ?? 0) + 1,
          source: 'admin',
          note: dto.note,
          createdById: adminId,
          models: {
            create: [...models.values()].map((m) => ({
              modelName: m.modelName,
              matchPattern: m.matchPattern,
              priority: m.priority,
              tiers: m.tiers as unknown as Prisma.InputJsonValue,
            })),
          },
        },
        select: versionSelect,
      });
    });

    await this.audit.record({
      ...ctx,
      action: 'prices.version_create',
      target: { type: 'price_version', id: created.id },
      after: {
        number: created.number,
        note: dto.note,
        upsert: upsertNames,
        remove: dto.remove,
      },
      result: 'ok',
    });
    return toSummary(created);
  }

  /** Which model price and tier the current version applies, and the cost (D3). */
  async test(dto: PriceTestDto): Promise<PriceTestResponse> {
    const head = await this.prisma.priceVersion.findFirst({
      orderBy: { number: 'desc' },
      select: { number: true, models: { select: modelSelect } },
    });
    const tokens = {
      input: dto.tokens.input ?? 0,
      output: dto.tokens.output ?? 0,
      cacheRead: dto.tokens.cacheRead ?? 0,
      cacheWrite5m: dto.tokens.cacheWrite5m ?? 0,
      cacheWrite1h: dto.tokens.cacheWrite1h ?? 0,
      reasoning: dto.tokens.reasoning ?? 0,
    };
    if (!head) {
      return { version: null, modelName: null, tier: null, costUsd: null };
    }
    const priced = priceRequest(
      compilePrices(head.models.map(toModelPrice)),
      dto.model,
      tokens,
    );
    return {
      version: head.number,
      modelName: priced?.modelName ?? null,
      tier: priced?.tier ?? null,
      costUsd: priced?.costUsd.toFixed(6) ?? null,
    };
  }
}
