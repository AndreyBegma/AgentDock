import type { LlmDefaultModel } from '@nautelle/shared';
import { Injectable } from '@nestjs/common';
import { LlmStore } from '../llm/llm-store';
import { boardAiError } from './board-ai-error';

/**
 * #660: the model of Ask the Board and triage — the instance default model
 * (Admin › AI providers). The gateway still refuses it when its provider is
 * disabled, keyless or at its cap.
 */
@Injectable()
export class BoardAiModel {
  constructor(private readonly store: LlmStore) {}

  /** The default model; null when none is set. */
  find(): Promise<LlmDefaultModel | null> {
    return this.store.defaultModel();
  }

  async pick(): Promise<LlmDefaultModel> {
    const model = await this.find();
    if (!model) {
      throw boardAiError(
        409,
        'ai_no_model',
        'No default model is set (Admin › AI providers)',
      );
    }
    return model;
  }

  /** Whether `provider`'s spend this month reached its cap. */
  async capReached(provider: LlmDefaultModel['provider']): Promise<boolean> {
    const [row, spend] = await Promise.all([
      this.store.provider(provider),
      this.store.providerSpend(provider),
    ]);
    return row.capUsd.gt(0) && spend.gte(row.capUsd);
  }
}
