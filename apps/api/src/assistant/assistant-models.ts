import {
  type AssistantModelOption,
  type LlmProviderId,
  llmModelSeesImages,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import { LlmStore } from '../llm/llm-store';
import { emptyUsage } from '../llm/types';
import { CostService } from '../prices/cost.service';
import { assistantError } from './assistant-error';

export interface PickedModel {
  provider: LlmProviderId;
  model: string;
}

/** The usage a model's price is compared at: a million in, a million out. */
const PRICE_PROBE = { ...emptyUsage(), input: 1_000_000, output: 1_000_000 };

/**
 * ADR-0060 §2: the models a conversation may use — every model enabled for a
 * provider that has a key and a cap above 0 — and the default and the
 * cheapest of them.
 */
@Injectable()
export class AssistantModels {
  constructor(
    private readonly store: LlmStore,
    private readonly cost: CostService,
  ) {}

  async options(): Promise<AssistantModelOption[]> {
    const [rows, fallback] = await Promise.all([
      this.store.providers(),
      this.store.defaultModel(),
    ]);
    return rows
      .filter((row) => row.capUsd.gt(0) && row.keyCiphertext !== null)
      .flatMap((row) =>
        row.models.map((model) => ({
          provider: row.provider,
          model,
          isDefault:
            fallback?.provider === row.provider && fallback.model === model,
          vision: llmModelSeesImages(model),
        })),
      );
  }

  /** Refuses a model that is not one of the options. */
  async assertEnabled(picked: PickedModel): Promise<void> {
    const options = await this.options();
    if (
      !options.some(
        (o) => o.provider === picked.provider && o.model === picked.model,
      )
    ) {
      throw assistantError(
        400,
        'assistant_model_not_enabled',
        `${picked.model} is not an enabled ${picked.provider} model`,
      );
    }
  }

  /** The conversation's model, or the instance default. */
  async pick(conversation: {
    provider: LlmProviderId | null;
    model: string | null;
  }): Promise<PickedModel> {
    if (conversation.provider && conversation.model) {
      return { provider: conversation.provider, model: conversation.model };
    }
    const fallback = await this.store.defaultModel();
    if (!fallback) {
      throw assistantError(
        409,
        'assistant_no_model',
        'No model is picked and no default model is set (Admin › AI providers)',
      );
    }
    return fallback;
  }

  /** The enabled model the current price table prices lowest; null with none. */
  async cheapest(): Promise<PickedModel | null> {
    const [options, pricer] = await Promise.all([
      this.options(),
      this.cost.current(),
    ]);
    let best: { picked: PickedModel; cost: number } | null = null;
    for (const option of options) {
      const cost = pricer.price(option.model, PRICE_PROBE).costUsd;
      if (cost === null) continue;
      if (!best || cost.toNumber() < best.cost) {
        best = {
          picked: { provider: option.provider, model: option.model },
          cost: cost.toNumber(),
        };
      }
    }
    return best?.picked ?? null;
  }
}
