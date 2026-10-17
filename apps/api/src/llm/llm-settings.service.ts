import {
  LLM_PROVIDER_INFO,
  type LlmDefaultModel,
  type LlmKeyTestResult,
  type LlmProviderId,
  type LlmProviderView,
  type LlmSettingsView,
  llmKeySuffix,
  llmMonthStart,
  llmNextReset,
} from '@agentdock/shared';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { CostService, type Pricer } from '../prices/cost.service';
import { SettingsService } from '../settings/settings.service';
import { LlmError } from './llm-error';
import { LLM_ADAPTERS, LlmSecrets } from './llm-secrets';
import {
  gatewayUnavailable,
  LLM_DEFAULT_MODEL_SETTING_KEY,
  LlmStore,
  type ProviderSpend,
  spendView,
} from './llm-store';
import { emptyUsage, type LlmAdapter } from './types';

/** How long a key test may take before it counts as a failure. */
const KEY_TEST_TIMEOUT_MS = 15_000;

const isPriced = (pricer: Pricer, model: string): boolean =>
  pricer.price(model, emptyUsage()).costSource !== null;

/**
 * The AI providers page (ADR-0058): keys, caps, enabled models, the default
 * model and this month's spend. Keys are write-only — no method returns one,
 * only its last four characters — and every change is audited without it.
 */
@Injectable()
export class LlmSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: LlmStore,
    private readonly settings: SettingsService,
    private readonly cost: CostService,
    private readonly audit: AuditService,
    private readonly secrets: LlmSecrets,
    @Inject(LLM_ADAPTERS)
    private readonly adapters: Record<LlmProviderId, LlmAdapter>,
  ) {}

  async view(): Promise<LlmSettingsView> {
    const now = this.store.now();
    const [rows, spend, pricer, defaultModel] = await Promise.all([
      this.store.providers(),
      this.store.monthSpend(now),
      this.cost.current(),
      this.store.defaultModel(),
    ]);
    const providers = rows.map((row): LlmProviderView => {
      const info = LLM_PROVIDER_INFO[row.provider];
      const own = spend[row.provider];
      return {
        provider: row.provider,
        label: info.label,
        key: {
          configured: row.keyCiphertext !== null,
          suffix: row.keySuffix,
          updatedAt: row.keyUpdatedAt?.toISOString() ?? null,
        },
        capUsd: row.capUsd.toFixed(2),
        enabled: row.capUsd.gt(0),
        capReached: row.capUsd.gt(0) && own.spendUsd.gte(row.capUsd),
        models: row.models.map((id) => ({ id, priced: isPriced(pricer, id) })),
        suggestedModels: [...info.suggestedModels],
        ...spendView(own),
      };
    });
    const totals = Object.values(spend).reduce<ProviderSpend>(
      (sum, s) => ({
        spendUsd: sum.spendUsd.add(s.spendUsd),
        requests: sum.requests + s.requests,
        inputTokens: sum.inputTokens + s.inputTokens,
        outputTokens: sum.outputTokens + s.outputTokens,
      }),
      {
        spendUsd: new Prisma.Decimal(0),
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    );
    return {
      gatewayAvailable: this.secrets.available,
      month: {
        start: llmMonthStart(now).toISOString(),
        resetsAt: llmNextReset(now).toISOString(),
      },
      providers,
      defaultModel,
      totals: spendView(totals),
    };
  }

  /** Sets or replaces a key. Audited with the suffixes only. */
  async setKey(
    provider: LlmProviderId,
    key: string,
    adminId: string,
    ctx: AuditContext,
  ): Promise<LlmSettingsView> {
    if (!this.secrets.available) throw gatewayUnavailable();
    const before = await this.store.provider(provider);
    const suffix = llmKeySuffix(key);
    await this.prisma.llmProviderSetting.update({
      where: { provider },
      data: {
        keyCiphertext: this.store.seal(key),
        keySuffix: suffix,
        keyUpdatedAt: this.store.now(),
        updatedById: adminId,
      },
    });
    await this.audit.record({
      ...ctx,
      action: 'llm.key_set',
      target: { type: 'llm_provider', id: provider },
      before: {
        configured: before.keyCiphertext !== null,
        suffix: before.keySuffix,
      },
      after: { configured: true, suffix },
      result: 'ok',
    });
    return this.view();
  }

  async deleteKey(
    provider: LlmProviderId,
    adminId: string,
    ctx: AuditContext,
  ): Promise<LlmSettingsView> {
    const before = await this.store.provider(provider);
    if (before.keyCiphertext !== null) {
      await this.prisma.llmProviderSetting.update({
        where: { provider },
        data: {
          keyCiphertext: null,
          keySuffix: null,
          keyUpdatedAt: this.store.now(),
          updatedById: adminId,
        },
      });
      await this.audit.record({
        ...ctx,
        action: 'llm.key_deleted',
        target: { type: 'llm_provider', id: provider },
        before: { configured: true, suffix: before.keySuffix },
        after: { configured: false },
        result: 'ok',
      });
    }
    return this.view();
  }

  /** Proves the stored key with a call that costs nothing. */
  async testKey(
    provider: LlmProviderId,
    ctx: AuditContext,
  ): Promise<LlmKeyTestResult> {
    const row = await this.store.provider(provider);
    const key = this.store.openKey(row);
    const started = Date.now();
    try {
      await this.adapters[provider].testKey(
        key,
        AbortSignal.timeout(KEY_TEST_TIMEOUT_MS),
      );
    } catch (error) {
      const failure =
        error instanceof LlmError
          ? error
          : new LlmError(
              'llm_provider_error',
              `${LLM_PROVIDER_INFO[provider].label} did not answer in time`,
              { provider },
            );
      await this.audit.record({
        ...ctx,
        action: 'llm.key_tested',
        target: { type: 'llm_provider', id: provider },
        result: 'error',
        meta: { error: failure.code, suffix: row.keySuffix },
      });
      throw failure;
    }
    const latencyMs = Date.now() - started;
    await this.audit.record({
      ...ctx,
      action: 'llm.key_tested',
      target: { type: 'llm_provider', id: provider },
      result: 'ok',
      meta: { latencyMs, suffix: row.keySuffix },
    });
    return { ok: true, latencyMs };
  }

  /** The cap and the enabled models; a model must be priced to be enabled. */
  async updateProvider(
    provider: LlmProviderId,
    update: { capUsd?: number; models?: string[] },
    adminId: string,
    ctx: AuditContext,
  ): Promise<LlmSettingsView> {
    const before = await this.store.provider(provider);
    const data: Prisma.LlmProviderSettingUpdateInput = {
      updatedBy: { connect: { id: adminId } },
    };
    if (update.capUsd !== undefined) {
      data.capUsd = new Prisma.Decimal(update.capUsd.toFixed(2));
    }
    if (update.models !== undefined) {
      const models = [...new Set(update.models.map((m) => m.trim()))];
      const pricer = await this.cost.current();
      const unpriced = models.filter(
        (m) => !before.models.includes(m) && !isPriced(pricer, m),
      );
      if (unpriced.length > 0) {
        throw new LlmError(
          'llm_model_unpriced',
          `Add a price for ${unpriced.join(', ')} under Admin › Prices before enabling it`,
          { provider },
        );
      }
      const current = await this.store.defaultModel();
      if (current?.provider === provider && !models.includes(current.model)) {
        throw new LlmError(
          'llm_invalid',
          `${current.model} is the default model; choose another default before disabling it`,
          { provider },
        );
      }
      data.models = models;
    }
    const after = await this.prisma.llmProviderSetting.update({
      where: { provider },
      data,
    });
    await this.audit.record({
      ...ctx,
      action: 'llm.provider_updated',
      target: { type: 'llm_provider', id: provider },
      before: { capUsd: before.capUsd.toFixed(2), models: before.models },
      after: { capUsd: after.capUsd.toFixed(2), models: after.models },
      result: 'ok',
    });
    return this.view();
  }

  async setDefaultModel(
    choice: LlmDefaultModel,
    adminId: string,
    ctx: AuditContext,
  ): Promise<LlmSettingsView> {
    const row = await this.store.provider(choice.provider);
    if (!row.models.includes(choice.model)) {
      throw new LlmError(
        'llm_model_not_enabled',
        `Enable ${choice.model} for ${LLM_PROVIDER_INFO[choice.provider].label} first`,
        { provider: choice.provider },
      );
    }
    const before = await this.store.defaultModel();
    const value = { provider: choice.provider, model: choice.model };
    await this.settings.set(LLM_DEFAULT_MODEL_SETTING_KEY, value, adminId);
    await this.audit.record({
      ...ctx,
      action: 'llm.default_model_set',
      target: { type: 'setting', id: LLM_DEFAULT_MODEL_SETTING_KEY },
      before: { defaultModel: before },
      after: { defaultModel: value },
      result: 'ok',
    });
    return this.view();
  }
}
