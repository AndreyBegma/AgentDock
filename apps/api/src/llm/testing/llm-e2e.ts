import type { LlmProviderId } from '@agentdock/shared';
import { INestApplication } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../app.module';
import { configureApp } from '../../configure-app';
import { PrismaService } from '../../database/prisma.service';
import type { E2eContext } from '../../test/e2e-app';
import { LLM_ADAPTERS, LLM_CLOCK } from '../llm-secrets';
import { AnthropicAdapter } from '../providers/anthropic.adapter';
import {
  OPENAI_PROFILE,
  OPENROUTER_PROFILE,
  OpenAiCompatibleAdapter,
  XAI_PROFILE,
} from '../providers/openai-compatible.adapter';
import type { LlmAdapter } from '../types';

type Fetch = typeof fetch;

export interface LlmE2eContext extends E2eContext {
  /** What every provider's HTTP answers; set per test. */
  providerFetch: jest.Mock<ReturnType<Fetch>, Parameters<Fetch>>;
  /** The gateway's clock; null is the real time. */
  clock: { now: Date | null };
}

/** What every provider's HTTP answers, and the gateway's clock; set per test. */
export type LlmMock = Pick<LlmE2eContext, 'providerFetch' | 'clock'>;

/**
 * `builder` with the real adapters on a mocked `fetch` and a settable clock;
 * the mock to drive them with.
 */
export const mockLlm = (
  builder: TestingModuleBuilder,
): { builder: TestingModuleBuilder; mock: LlmMock } => {
  const providerFetch = jest.fn<ReturnType<Fetch>, Parameters<Fetch>>(
    async () => {
      throw new Error('no provider answer set for this test');
    },
  );
  const clock: { now: Date | null } = { now: null };
  const viaMock: Fetch = (...args) => providerFetch(...args);
  return {
    builder: builder
      .overrideProvider(LLM_ADAPTERS)
      .useValue({
        anthropic: new AnthropicAdapter({ fetch: viaMock }),
        openai: new OpenAiCompatibleAdapter(OPENAI_PROFILE, viaMock),
        xai: new OpenAiCompatibleAdapter(XAI_PROFILE, viaMock),
        openrouter: new OpenAiCompatibleAdapter(OPENROUTER_PROFILE, viaMock),
      } satisfies Record<LlmProviderId, LlmAdapter>)
      .overrideProvider(LLM_CLOCK)
      .useValue(() => clock.now ?? new Date()),
    mock: { providerFetch, clock },
  };
};

/**
 * The app with the real adapters on a mocked `fetch` and a settable clock.
 * `LLM_SECRETS_KEY` is read at start-up: set it before calling.
 */
export const createLlmE2eApp = async (): Promise<LlmE2eContext> => {
  const { builder, mock } = mockLlm(
    Test.createTestingModule({ imports: [AppModule] }),
  );
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();
  return {
    app,
    prisma: app.get(PrismaService),
    http: () => request(app.getHttpServer()),
    ...mock,
  };
};

/** A price version pricing the given models at $4 / $20 per million tokens. */
export const seedLlmPrices = (
  prisma: PrismaService,
  models: readonly string[],
) =>
  prisma.priceVersion.create({
    data: {
      number: 1,
      source: 'admin',
      note: 'llm e2e',
      models: {
        create: models.map((modelName) => ({
          modelName,
          matchPattern: `^${modelName.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`,
          priority: 0,
          tiers: [
            {
              name: 'Standard',
              isDefault: true,
              conditions: [],
              prices: { input: '0.000004', output: '0.00002' },
            },
          ] as unknown as Prisma.InputJsonValue,
        })),
      },
    },
  });
