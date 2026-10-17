import {
  LLM_PROVIDER_INFO,
  type LlmErrorCode,
  type LlmProviderId,
  llmNextReset,
} from '@agentdock/shared';
import type { TokenBuckets } from '@agentdock/shared/protocol';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { LlmCallOutcome } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { CostService } from '../prices/cost.service';
import { LlmError } from './llm-error';
import { LLM_ADAPTERS, LlmSecrets } from './llm-secrets';
import { gatewayUnavailable, LlmStore } from './llm-store';
import { isAbort } from './providers/provider-errors';
import { redactSecrets } from './redact';
import {
  emptyUsage,
  type LlmAdapter,
  type LlmCallInput,
  type LlmCompletion,
  type LlmStopReason,
  type LlmStreamEvent,
  type LlmToolCall,
} from './types';

const addUsage = (a: TokenBuckets, b: TokenBuckets): TokenBuckets => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
  cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
  reasoning: a.reasoning + b.reasoning,
});

/**
 * The one way the API calls a model (ADR-0057). A call is refused before it
 * reaches the provider when the gateway did not start, the provider is
 * disabled (cap 0), the model is not enabled or not priced, no key is set, or
 * this month's spend reached the cap. Every call that reaches the provider
 * writes one `llm_calls` row, priced from the current price table, however it
 * ends.
 */
@Injectable()
export class LlmGateway {
  private readonly logger = new Logger(LlmGateway.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: LlmStore,
    private readonly cost: CostService,
    private readonly secrets: LlmSecrets,
    @Inject(LLM_ADAPTERS)
    private readonly adapters: Record<LlmProviderId, LlmAdapter>,
  ) {}

  /** Streams one call; the ledger row is written when the stream ends. */
  stream(input: LlmCallInput): AsyncIterable<LlmStreamEvent> {
    return this.run(input, {});
  }

  /** One call, collected: the text, the tool calls, the usage and the cost. */
  async complete(input: LlmCallInput): Promise<LlmCompletion> {
    const ledger: { costUsd?: string } = {};
    let text = '';
    const toolCalls: LlmToolCall[] = [];
    let usage = emptyUsage();
    let stopReason: LlmStopReason = 'other';
    for await (const event of this.run(input, ledger)) {
      if (event.type === 'text') text += event.text;
      else if (event.type === 'tool_call') toolCalls.push(event.call);
      else if (event.type === 'usage') usage = addUsage(usage, event.usage);
      else stopReason = event.stopReason;
    }
    return { text, toolCalls, usage, stopReason, costUsd: ledger.costUsd ?? '0' };
  }

  /** `ledger.costUsd` is set to the cost written once the row is. */
  private async *run(
    input: LlmCallInput,
    ledger: { costUsd?: string },
  ): AsyncIterable<LlmStreamEvent> {
    const { provider, request } = input;
    const label = LLM_PROVIDER_INFO[provider].label;
    if (!this.secrets.available) throw gatewayUnavailable();

    const row = await this.store.provider(provider);
    if (row.capUsd.lte(0)) {
      throw new LlmError(
        'llm_provider_disabled',
        `${label} is disabled: its monthly cap is 0`,
        { provider },
      );
    }
    if (!row.models.includes(request.model)) {
      throw new LlmError(
        'llm_model_not_enabled',
        `${request.model} is not enabled for ${label}`,
        { provider },
      );
    }
    const pricer = await this.cost.current();
    if (pricer.price(request.model, emptyUsage()).costSource === null) {
      throw new LlmError(
        'llm_model_unpriced',
        `No price in the price table matches ${request.model}`,
        { provider },
      );
    }
    const now = this.store.now();
    const spend = await this.store.providerSpend(provider, now);
    if (spend.gte(row.capUsd)) {
      const resetsAt = llmNextReset(now);
      throw new LlmError(
        'llm_cap_reached',
        `${label} reached its $${row.capUsd.toFixed(2)} monthly cap; calls resume ${resetsAt.toISOString()}`,
        { provider, resetsAt },
      );
    }
    const apiKey = this.store.openKey(row);

    const started = Date.now();
    let usage = emptyUsage();
    let outcome: LlmCallOutcome = 'aborted';
    let errorCode: LlmErrorCode | null = null;
    try {
      for await (const event of this.adapters[provider].stream({
        apiKey,
        request,
        signal: input.signal,
      })) {
        if (event.type === 'usage') usage = addUsage(usage, event.usage);
        if (event.type === 'end') outcome = 'ok';
        yield event;
      }
    } catch (error) {
      if (isAbort(error)) throw error;
      outcome = 'error';
      errorCode = error instanceof LlmError ? error.code : 'llm_provider_error';
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `${provider} ${request.model} (${input.feature}) failed: ${redactSecrets(message, [apiKey])}`,
      );
      if (error instanceof LlmError) throw error;
      throw new LlmError('llm_provider_error', `${label} failed`, { provider });
    } finally {
      const priced = pricer.price(request.model, usage);
      const costUsd = priced.costUsd ?? 0;
      await this.prisma.llmCall.create({
        data: {
          ts: now,
          userId: input.userId,
          provider,
          model: request.model,
          feature: input.feature,
          outcome,
          errorCode,
          ...usage,
          costUsd,
          priceVersion: priced.priceVersion ?? 0,
          durationMs: Date.now() - started,
        },
      });
      ledger.costUsd = costUsd.toString();
    }
  }

}

