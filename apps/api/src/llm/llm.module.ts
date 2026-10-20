import type { LlmProviderId } from '@nautelle/shared';
import { Logger, Module } from '@nestjs/common';
import { PricesModule } from '../prices/prices.module';
import { SettingsModule } from '../settings/settings.module';
import { LlmController } from './llm.controller';
import { LlmGateway } from './llm-gateway.service';
import {
  LLM_ADAPTERS,
  LLM_CLOCK,
  LLM_SECRETS_KEY_ENV,
  type LlmClock,
  LlmSecrets,
} from './llm-secrets';
import { LlmSettingsService } from './llm-settings.service';
import { LlmStore } from './llm-store';
import { AnthropicAdapter } from './providers/anthropic.adapter';
import {
  OPENAI_PROFILE,
  OPENROUTER_PROFILE,
  OpenAiCompatibleAdapter,
  XAI_PROFILE,
} from './providers/openai-compatible.adapter';
import type { LlmAdapter } from './types';

/**
 * The LLM gateway (ADR-0059): the API's direct calls to model providers.
 * Without a well-formed `LLM_SECRETS_KEY` the gateway does not start — every
 * call and every key route answers `llm_gateway_unavailable` — and the rest
 * of the API runs on, so a missing AI key never takes the control plane down.
 */
@Module({
  imports: [PricesModule, SettingsModule],
  controllers: [LlmController],
  providers: [
    {
      provide: LlmSecrets,
      useFactory: (): LlmSecrets => {
        const secrets = LlmSecrets.fromEnv();
        if (secrets.problem) {
          new Logger('LlmGateway').error(
            `${LLM_SECRETS_KEY_ENV} is ${secrets.problem === 'missing' ? 'not set' : 'not base64 of 32 bytes'}; the LLM gateway did not start`,
          );
        }
        return secrets;
      },
    },
    {
      provide: LLM_ADAPTERS,
      useFactory: (): Record<LlmProviderId, LlmAdapter> => ({
        anthropic: new AnthropicAdapter(),
        openai: new OpenAiCompatibleAdapter(OPENAI_PROFILE),
        xai: new OpenAiCompatibleAdapter(XAI_PROFILE),
        openrouter: new OpenAiCompatibleAdapter(OPENROUTER_PROFILE),
      }),
    },
    { provide: LLM_CLOCK, useValue: (() => new Date()) satisfies LlmClock },
    LlmStore,
    LlmGateway,
    LlmSettingsService,
  ],
  exports: [LlmGateway, LlmStore],
})
export class LlmModule {}
