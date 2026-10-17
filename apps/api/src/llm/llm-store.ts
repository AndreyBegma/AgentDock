import {
  LLM_PROVIDER_INFO,
  LLM_PROVIDERS,
  type LlmDefaultModel,
  type LlmProviderId,
  type LlmSpendView,
  isLlmProvider,
  llmMonthStart,
} from '@agentdock/shared';
import { Inject, Injectable } from '@nestjs/common';
import { type LlmProviderSetting, Prisma } from '@prisma/client';
import { SecretCipherError } from '../common/crypto';
import { PrismaService } from '../database/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { LlmError } from './llm-error';
import { LLM_CLOCK, type LlmClock, LlmSecrets } from './llm-secrets';

/** The `settings` row of the instance default model. */
export const LLM_DEFAULT_MODEL_SETTING_KEY = 'llm.defaultModel';

const ZERO = new Prisma.Decimal(0);

export interface ProviderSpend {
  spendUsd: Prisma.Decimal;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

const emptySpend = (): ProviderSpend => ({
  spendUsd: ZERO,
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
});

export const spendView = (spend: ProviderSpend): LlmSpendView => ({
  spendUsd: spend.spendUsd.toFixed(2),
  requests: spend.requests,
  inputTokens: spend.inputTokens,
  outputTokens: spend.outputTokens,
});

/**
 * The gateway's rows: provider settings, the sealed keys, the default model
 * and this month's spend. Shared by the admin routes and the gateway.
 */
@Injectable()
export class LlmStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly secrets: LlmSecrets,
    @Inject(LLM_CLOCK) private readonly clock: LlmClock,
  ) {}

  now(): Date {
    return this.clock();
  }

  /**
   * Every provider's row, in `LLM_PROVIDERS` order. The migration writes them;
   * a missing one is written with its default cap (Anthropic $200, else 0).
   */
  async providers(): Promise<LlmProviderSetting[]> {
    await this.prisma.llmProviderSetting.createMany({
      data: LLM_PROVIDERS.map((provider) => ({
        provider,
        capUsd: LLM_PROVIDER_INFO[provider].defaultCapUsd,
      })),
      skipDuplicates: true,
    });
    const rows = await this.prisma.llmProviderSetting.findMany();
    return LLM_PROVIDERS.map((id) => {
      const row = rows.find((r) => r.provider === id);
      if (!row) throw new Error(`llm_provider_settings has no ${id} row`);
      return row;
    });
  }

  async provider(provider: LlmProviderId): Promise<LlmProviderSetting> {
    const rows = await this.providers();
    return rows.find((r) => r.provider === provider) as LlmProviderSetting;
  }

  /** The stored key in the clear, for one call to its provider only. */
  openKey(row: LlmProviderSetting): string {
    if (!this.secrets.available) throw gatewayUnavailable();
    if (!row.keyCiphertext) {
      throw new LlmError(
        'llm_key_missing',
        `No key is set for ${LLM_PROVIDER_INFO[row.provider].label}`,
        { provider: row.provider },
      );
    }
    try {
      return this.secrets.cipher.decrypt(row.keyCiphertext);
    } catch (error) {
      if (!(error instanceof SecretCipherError)) throw error;
      // Fixed text: it carries neither the master key nor the provider key.
      throw new LlmError(
        'llm_gateway_unavailable',
        `The stored ${LLM_PROVIDER_INFO[row.provider].label} key cannot be opened with LLM_SECRETS_KEY: ${error.message}`,
        { provider: row.provider },
      );
    }
  }

  seal(key: string): string {
    if (!this.secrets.available) throw gatewayUnavailable();
    return this.secrets.cipher.encrypt(key);
  }

  async defaultModel(): Promise<LlmDefaultModel | null> {
    const value = await this.settings.get(LLM_DEFAULT_MODEL_SETTING_KEY);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const { provider, model } = value as Record<string, unknown>;
    return isLlmProvider(provider) && typeof model === 'string'
      ? { provider, model }
      : null;
  }

  /** Spend of the UTC month that holds `now`, per provider (ADR-0057 §5). */
  async monthSpend(
    now: Date = this.now(),
  ): Promise<Record<LlmProviderId, ProviderSpend>> {
    const groups = await this.prisma.llmCall.groupBy({
      by: ['provider'],
      where: { ts: { gte: llmMonthStart(now) } },
      _sum: {
        costUsd: true,
        input: true,
        output: true,
        cacheRead: true,
        cacheWrite5m: true,
        cacheWrite1h: true,
      },
      _count: { _all: true },
    });
    const out = Object.fromEntries(
      LLM_PROVIDERS.map((p) => [p, emptySpend()]),
    ) as Record<LlmProviderId, ProviderSpend>;
    for (const group of groups) {
      const sum = group._sum;
      out[group.provider] = {
        spendUsd: sum.costUsd ?? ZERO,
        requests: group._count._all,
        inputTokens:
          (sum.input ?? 0) +
          (sum.cacheRead ?? 0) +
          (sum.cacheWrite5m ?? 0) +
          (sum.cacheWrite1h ?? 0),
        outputTokens: sum.output ?? 0,
      };
    }
    return out;
  }

  /** One provider's spend this month — what its cap is checked against. */
  async providerSpend(
    provider: LlmProviderId,
    now: Date = this.now(),
  ): Promise<Prisma.Decimal> {
    const sum = await this.prisma.llmCall.aggregate({
      where: { provider, ts: { gte: llmMonthStart(now) } },
      _sum: { costUsd: true },
    });
    return sum._sum.costUsd ?? ZERO;
  }
}

export const gatewayUnavailable = (): LlmError =>
  new LlmError(
    'llm_gateway_unavailable',
    'The LLM gateway is not running: LLM_SECRETS_KEY is missing or is not base64 of 32 bytes',
  );
