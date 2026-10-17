import { randomBytes } from 'node:crypto';
import type { LlmErrorBody, LlmSettingsView } from '@agentdock/shared';
import { Logger } from '@nestjs/common';
import { SecretCipher } from '../common/crypto';
import {
  createUser,
  login,
  resetDatabase,
  type Session,
} from '../test/e2e-app';
import { LlmError } from './llm-error';
import { LlmGateway } from './llm-gateway.service';
import { LLM_SECRETS_KEY_ENV } from './llm-secrets';
import { jsonResponse, sseResponse } from './providers/testing';
import {
  createLlmE2eApp,
  type LlmE2eContext,
  seedLlmPrices,
} from './testing/llm-e2e';
import type { LlmRequest } from './types';

const MASTER_KEY = randomBytes(32).toString('base64');
/** Not real keys: every provider call goes to the mocked fetch. */
const ANTHROPIC_KEY = 'sk-ant-api03-e2e-secret-value-XyZ1-4f2a';
const OPENAI_KEY = 'sk-proj-e2e-secret-value-AbC2-91bd';
const OPUS = 'claude-opus-5-5';
const GPT = 'gpt-5.1';

/** One Anthropic answer: `text`, then the given usage. */
const anthropicAnswer = (text: string, input: number, output: number) =>
  sseResponse([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: OPUS,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: input, output_tokens: 1 },
        },
      },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: output },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);

const ask = (model = OPUS): LlmRequest => ({
  model,
  messages: [{ role: 'user', content: 'Hello' }],
});

describe('LLM gateway (e2e)', () => {
  let ctx: LlmE2eContext;
  let admin: Session;
  let adminId: string;
  let gateway: LlmGateway;
  /** Every line any Nest logger wrote during a test. */
  let logged: string[];
  let auditFrom: bigint;

  beforeAll(async () => {
    process.env[LLM_SECRETS_KEY_ENV] = MASTER_KEY;
    ctx = await createLlmE2eApp();
    gateway = ctx.app.get(LlmGateway);
  });
  afterAll(async () => {
    await ctx.app.close();
    process.env[LLM_SECRETS_KEY_ENV] = '';
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await ctx.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE price_versions, llm_calls, llm_provider_settings CASCADE',
    );
    // `audit_records` is append-only: each test reads only the records after this.
    auditFrom =
      (await ctx.prisma.auditRecord.aggregate({ _max: { seq: true } }))._max
        .seq ?? 0n;
    await seedLlmPrices(ctx.prisma, [OPUS, GPT]);
    adminId = (await createUser(ctx.prisma, 'admin@example.com', 'admin')).id;
    admin = await login(ctx, 'admin@example.com');
    ctx.clock.now = null;
    ctx.providerFetch.mockReset();
    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          logged.push(args.map(String).join(' '));
        });
    }
  });
  afterEach(() => jest.restoreAllMocks());

  const view = async (): Promise<LlmSettingsView> => {
    const res = await admin.get('/admin/llm');
    expect(res.status).toBe(200);
    return res.body as LlmSettingsView;
  };

  const setKey = async (provider: string, key: string) => {
    const res = await admin.send(
      'put',
      `/admin/llm/providers/${provider}/key`,
      {
        key,
      },
    );
    expect(res.status).toBe(200);
    return res;
  };

  const enable = async (provider: string, body: object) => {
    const res = await admin.send(
      'patch',
      `/admin/llm/providers/${provider}`,
      body,
    );
    expect(res.status).toBe(200);
    return res.body as LlmSettingsView;
  };

  const refusal = async (promise: Promise<unknown>): Promise<LlmError> => {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(LlmError);
    return error as LlmError;
  };

  describe('access', () => {
    const routes: [
      string,
      'get' | 'put' | 'delete' | 'post' | 'patch',
      object?,
    ][] = [
      ['/admin/llm', 'get'],
      ['/admin/llm/providers/anthropic/key', 'put', { key: ANTHROPIC_KEY }],
      ['/admin/llm/providers/anthropic/key', 'delete'],
      ['/admin/llm/providers/anthropic/key/test', 'post'],
      ['/admin/llm/providers/anthropic', 'patch', { capUsd: 10 }],
      [
        '/admin/llm/default-model',
        'put',
        { provider: 'anthropic', model: OPUS },
      ],
    ];

    it.each([
      'operator',
      'viewer',
    ] as const)('refuses a %s with 403 on every key and settings route', async (role) => {
      await createUser(ctx.prisma, `${role}@example.com`, role);
      const user = await login(ctx, `${role}@example.com`);
      for (const [path, method, body] of routes) {
        const res =
          method === 'get'
            ? await user.get(path)
            : await user.send(method, path, body);
        expect([path, method, res.status]).toEqual([path, method, 403]);
      }
      // Refused before any handler ran: not even the default rows were written.
      expect(await ctx.prisma.llmProviderSetting.count()).toBe(0);
    });

    it('refuses an unknown provider', async () => {
      const res = await admin.send('put', '/admin/llm/providers/gemini/key', {
        key: ANTHROPIC_KEY,
      });
      expect(res.status).toBe(400);
    });
  });

  describe('defaults', () => {
    it('starts Anthropic at a $200 cap and every other provider disabled', async () => {
      const state = await view();
      expect(state.gatewayAvailable).toBe(true);
      expect(
        state.providers.map((p) => [
          p.provider,
          p.capUsd,
          p.enabled,
          p.key.configured,
        ]),
      ).toEqual([
        ['anthropic', '200.00', true, false],
        ['openai', '0.00', false, false],
        ['xai', '0.00', false, false],
        ['openrouter', '0.00', false, false],
      ]);
      expect(state.defaultModel).toBeNull();
      expect(state.month).toEqual({
        start: expect.stringMatching(/-01T00:00:00\.000Z$/),
        resetsAt: expect.stringMatching(/-01T00:00:00\.000Z$/),
      });
    });

    it('keeps a provider with a key and a model disabled until its cap is above 0', async () => {
      await setKey('openai', OPENAI_KEY);
      await enable('openai', { models: [GPT] });
      const error = await refusal(
        gateway.complete({
          userId: adminId,
          feature: 'digest',
          provider: 'openai',
          request: ask(GPT),
        }),
      );
      expect(error.code).toBe('llm_provider_disabled');
      expect(ctx.providerFetch).not.toHaveBeenCalled();

      await enable('openai', { capUsd: 25 });
      ctx.providerFetch.mockImplementation(async () =>
        sseResponse([
          {
            data: {
              choices: [
                { index: 0, delta: { content: 'ok' }, finish_reason: 'stop' },
              ],
            },
          },
          {
            data: {
              choices: [],
              usage: { prompt_tokens: 10, completion_tokens: 2 },
            },
          },
          { data: '[DONE]' },
        ]),
      );
      const done = await gateway.complete({
        userId: adminId,
        feature: 'digest',
        provider: 'openai',
        request: ask(GPT),
      });
      expect(done.text).toBe('ok');
    });
  });

  describe('keys', () => {
    it('stores a key encrypted with LLM_SECRETS_KEY and returns only its last four characters', async () => {
      const res = await setKey('anthropic', ANTHROPIC_KEY);
      const anthropic = (res.body as LlmSettingsView).providers[0];
      expect(anthropic.key).toEqual({
        configured: true,
        suffix: '4f2a',
        updatedAt: expect.any(String),
      });

      const row = await ctx.prisma.llmProviderSetting.findUniqueOrThrow({
        where: { provider: 'anthropic' },
      });
      expect(row.keyCiphertext).not.toContain(ANTHROPIC_KEY);
      expect(
        SecretCipher.fromKeyText(MASTER_KEY).decrypt(row.keyCiphertext ?? ''),
      ).toBe(ANTHROPIC_KEY);
      // A random IV per value: the same key seals differently every time.
      await setKey('anthropic', ANTHROPIC_KEY);
      const again = await ctx.prisma.llmProviderSetting.findUniqueOrThrow({
        where: { provider: 'anthropic' },
      });
      expect(again.keyCiphertext).not.toBe(row.keyCiphertext);
    });

    it('never puts the raw key in a response, a log line or an event', async () => {
      const bodies: string[] = [];
      const keep = (res: { text: string }) => bodies.push(res.text);

      keep(await setKey('anthropic', ANTHROPIC_KEY));
      keep(await setKey('anthropic', `${ANTHROPIC_KEY}-v2`));
      keep(await admin.get('/admin/llm'));

      ctx.providerFetch.mockImplementation(async () =>
        jsonResponse({
          data: [],
          has_more: false,
          first_id: null,
          last_id: null,
        }),
      );
      keep(await admin.send('post', '/admin/llm/providers/anthropic/key/test'));

      // A provider that echoes the key in its error.
      ctx.providerFetch.mockImplementation(async () =>
        jsonResponse(
          {
            type: 'error',
            error: {
              type: 'authentication_error',
              message: `invalid x-api-key ${ANTHROPIC_KEY}-v2`,
            },
          },
          401,
        ),
      );
      const failedTest = await admin.send(
        'post',
        '/admin/llm/providers/anthropic/key/test',
      );
      expect(failedTest.status).toBe(400);
      expect((failedTest.body as LlmErrorBody).error).toBe('llm_key_rejected');
      keep(failedTest);

      ctx.providerFetch.mockImplementation(async () =>
        jsonResponse(
          {
            type: 'error',
            error: {
              type: 'overloaded_error',
              message: `busy for ${ANTHROPIC_KEY}-v2`,
            },
          },
          529,
        ),
      );
      await enable('anthropic', { models: [OPUS] });
      const failedCall = await refusal(
        gateway.complete({
          userId: adminId,
          feature: 'assistant',
          provider: 'anthropic',
          request: ask(),
        }),
      );
      expect(failedCall.code).toBe('llm_provider_error');
      bodies.push(
        JSON.stringify(failedCall.getResponse()),
        failedCall.stack ?? '',
      );

      keep(await admin.send('delete', '/admin/llm/providers/anthropic/key'));

      const audits = await ctx.prisma.auditRecord.findMany({
        where: { seq: { gt: auditFrom }, action: { startsWith: 'llm.' } },
      });
      expect(audits.map((a) => a.action)).toEqual(
        expect.arrayContaining([
          'llm.key_set',
          'llm.key_tested',
          'llm.key_deleted',
        ]),
      );
      const events = await ctx.prisma.event.findMany();
      const calls = await ctx.prisma.llmCall.findMany();
      expect(calls).toHaveLength(1);

      const everything = [
        ...bodies,
        ...logged,
        JSON.stringify(audits, (_k, v: unknown) =>
          typeof v === 'bigint' ? v.toString() : v,
        ),
        JSON.stringify(events, (_k, v: unknown) =>
          typeof v === 'bigint' ? v.toString() : v,
        ),
        JSON.stringify(calls),
      ].join('\n');
      expect(everything).toContain('4f2a');
      expect(everything).not.toContain(ANTHROPIC_KEY);
      expect(everything).not.toContain(ANTHROPIC_KEY.slice(0, -4));
      expect(logged.some((line) => line.includes('[redacted]'))).toBe(true);
    });

    it('records each key change as an audit event with the suffix, not the value', async () => {
      await setKey('anthropic', ANTHROPIC_KEY);
      await admin.send('delete', '/admin/llm/providers/anthropic/key');
      const audits = await ctx.prisma.auditRecord.findMany({
        where: {
          seq: { gt: auditFrom },
          action: { in: ['llm.key_set', 'llm.key_deleted'] },
        },
        orderBy: { seq: 'asc' },
      });
      expect(audits.map((a) => [a.action, a.before, a.after])).toEqual([
        [
          'llm.key_set',
          { configured: false, suffix: null },
          { configured: true, suffix: '4f2a' },
        ],
        [
          'llm.key_deleted',
          { configured: true, suffix: '4f2a' },
          { configured: false },
        ],
      ]);
    });

    it('tests a stored key, and refuses to test a missing one', async () => {
      const missing = await admin.send(
        'post',
        '/admin/llm/providers/anthropic/key/test',
      );
      expect(missing.status).toBe(409);
      expect((missing.body as LlmErrorBody).error).toBe('llm_key_missing');

      await setKey('anthropic', ANTHROPIC_KEY);
      ctx.providerFetch.mockImplementation(async () =>
        jsonResponse({
          data: [],
          has_more: false,
          first_id: null,
          last_id: null,
        }),
      );
      const ok = await admin.send(
        'post',
        '/admin/llm/providers/anthropic/key/test',
      );
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ ok: true, latencyMs: expect.any(Number) });
    });

    it('refuses a call once the key is deleted', async () => {
      await setKey('anthropic', ANTHROPIC_KEY);
      await enable('anthropic', { models: [OPUS] });
      const deleted = await admin.send(
        'delete',
        '/admin/llm/providers/anthropic/key',
      );
      expect((deleted.body as LlmSettingsView).providers[0].key).toEqual({
        configured: false,
        suffix: null,
        updatedAt: expect.any(String),
      });
      const error = await refusal(
        gateway.complete({
          userId: adminId,
          feature: 'assistant',
          provider: 'anthropic',
          request: ask(),
        }),
      );
      expect(error.code).toBe('llm_key_missing');
    });
  });

  describe('model registry', () => {
    it('enables only models the price table prices', async () => {
      const res = await admin.send('patch', '/admin/llm/providers/anthropic', {
        models: [OPUS, 'claude-unpriced-1'],
      });
      expect(res.status).toBe(400);
      expect((res.body as LlmErrorBody).error).toBe('llm_model_unpriced');

      const state = await enable('anthropic', { models: [OPUS] });
      expect(state.providers[0].models).toEqual([{ id: OPUS, priced: true }]);
    });

    it('sets the default model only to an enabled one, and keeps it enabled', async () => {
      const early = await admin.send('put', '/admin/llm/default-model', {
        provider: 'anthropic',
        model: OPUS,
      });
      expect(early.status).toBe(400);
      expect((early.body as LlmErrorBody).error).toBe('llm_model_not_enabled');

      await enable('anthropic', { models: [OPUS] });
      const set = await admin.send('put', '/admin/llm/default-model', {
        provider: 'anthropic',
        model: OPUS,
      });
      expect(set.status).toBe(200);
      expect((set.body as LlmSettingsView).defaultModel).toEqual({
        provider: 'anthropic',
        model: OPUS,
      });

      const disable = await admin.send(
        'patch',
        '/admin/llm/providers/anthropic',
        {
          models: [],
        },
      );
      expect(disable.status).toBe(400);
      expect((disable.body as LlmErrorBody).error).toBe('llm_invalid');
    });

    it('refuses a call to a model that is not enabled', async () => {
      await setKey('anthropic', ANTHROPIC_KEY);
      const error = await refusal(
        gateway.complete({
          userId: adminId,
          feature: 'assistant',
          provider: 'anthropic',
          request: ask(),
        }),
      );
      expect(error.code).toBe('llm_model_not_enabled');
    });

    it('validates caps', async () => {
      for (const capUsd of [-1, 1.234, 'ten']) {
        const res = await admin.send(
          'patch',
          '/admin/llm/providers/anthropic',
          { capUsd },
        );
        expect(res.status).toBe(400);
      }
    });
  });

  describe('usage ledger', () => {
    beforeEach(async () => {
      await setKey('anthropic', ANTHROPIC_KEY);
      await enable('anthropic', { models: [OPUS] });
    });

    it('writes one row per call, priced from the price table', async () => {
      ctx.providerFetch.mockImplementation(async () =>
        anthropicAnswer('Hi there', 1000, 500),
      );
      const done = await gateway.complete({
        userId: adminId,
        feature: 'summary',
        provider: 'anthropic',
        request: ask(),
      });
      expect(done).toMatchObject({
        text: 'Hi there',
        stopReason: 'end',
        costUsd: '0.014',
      });

      const rows = await ctx.prisma.llmCall.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        userId: adminId,
        provider: 'anthropic',
        model: OPUS,
        feature: 'summary',
        outcome: 'ok',
        errorCode: null,
        input: 1000,
        output: 500,
        priceVersion: 1,
      });
      expect(rows[0].costUsd.toFixed(6)).toBe('0.014000');

      const state = await view();
      expect(state.providers[0]).toMatchObject({
        spendUsd: '0.01',
        requests: 1,
        inputTokens: 1000,
        outputTokens: 500,
      });
      expect(state.totals.requests).toBe(1);
    });

    it('writes a row for a failed call too', async () => {
      ctx.providerFetch.mockImplementation(async () =>
        jsonResponse(
          { type: 'error', error: { type: 'api_error', message: 'boom' } },
          500,
        ),
      );
      await refusal(
        gateway.complete({
          userId: null,
          feature: 'triage',
          provider: 'anthropic',
          request: ask(),
        }),
      );
      const rows = await ctx.prisma.llmCall.findMany();
      expect(rows).toMatchObject([
        {
          userId: null,
          feature: 'triage',
          outcome: 'error',
          errorCode: 'llm_provider_error',
        },
      ]);
    });

    it('streams events as they arrive and writes the row at the end', async () => {
      ctx.providerFetch.mockImplementation(async () =>
        anthropicAnswer('Hi', 10, 5),
      );
      const types: string[] = [];
      for await (const event of gateway.stream({
        userId: adminId,
        feature: 'assistant',
        provider: 'anthropic',
        request: ask(),
      })) {
        types.push(event.type);
      }
      expect(types).toEqual(['text', 'usage', 'end']);
      expect(await ctx.prisma.llmCall.count()).toBe(1);
    });
  });

  describe('caps', () => {
    const callAt = async (iso: string) => {
      ctx.clock.now = new Date(iso);
      ctx.providerFetch.mockImplementation(async () =>
        anthropicAnswer('ok', 1, 1),
      );
      return gateway.complete({
        userId: adminId,
        feature: 'assistant',
        provider: 'anthropic',
        request: ask(),
      });
    };

    const spent = (iso: string, costUsd: string) =>
      ctx.prisma.llmCall.create({
        data: {
          ts: new Date(iso),
          userId: adminId,
          provider: 'anthropic',
          model: OPUS,
          feature: 'assistant',
          outcome: 'ok',
          costUsd,
          priceVersion: 1,
          durationMs: 1,
        },
      });

    beforeEach(async () => {
      await setKey('anthropic', ANTHROPIC_KEY);
      await enable('anthropic', { models: [OPUS], capUsd: 10 });
    });

    it('allows calls below the cap', async () => {
      await spent('2026-10-15T12:00:00Z', '9.99');
      await expect(callAt('2026-10-31T23:59:59.999Z')).resolves.toMatchObject({
        text: 'ok',
      });
    });

    it('refuses with llm_cap_reached once the cap is reached, until 00:00 UTC on the 1st', async () => {
      await spent('2026-10-31T23:00:00Z', '10.00');

      const refused = await refusal(callAt('2026-10-31T23:59:59.999Z'));
      expect(refused.code).toBe('llm_cap_reached');
      expect(refused.getResponse()).toMatchObject({
        statusCode: 429,
        error: 'llm_cap_reached',
        provider: 'anthropic',
        resetsAt: '2026-11-01T00:00:00.000Z',
      });
      expect(ctx.providerFetch).not.toHaveBeenCalled();

      // October's spend no longer counts in November.
      await expect(callAt('2026-11-01T00:00:00.000Z')).resolves.toMatchObject({
        text: 'ok',
      });
    });

    it('shows the cap as reached on the settings page', async () => {
      await spent(new Date().toISOString(), '10.00');
      const anthropic = (await view()).providers[0];
      expect(anthropic).toMatchObject({
        capReached: true,
        spendUsd: '10.00',
        capUsd: '10.00',
      });
    });

    it('lets a raised cap through again', async () => {
      await spent('2026-10-20T00:00:00Z', '10.00');
      await refusal(callAt('2026-10-20T01:00:00Z'));
      await enable('anthropic', { capUsd: 20 });
      await expect(callAt('2026-10-20T01:00:00Z')).resolves.toMatchObject({
        text: 'ok',
      });
    });
  });
});

describe.each([
  ['missing', ''],
  ['malformed', 'bm90LTMyLWJ5dGVz'],
])('LLM gateway with LLM_SECRETS_KEY %s (e2e)', (_problem, value) => {
  let ctx: LlmE2eContext;
  let admin: Session;
  const errors: string[] = [];

  beforeAll(async () => {
    process.env[LLM_SECRETS_KEY_ENV] = value;
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      });
    ctx = await createLlmE2eApp();
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await ctx.app.close();
    process.env[LLM_SECRETS_KEY_ENV] = '';
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await createUser(ctx.prisma, 'admin@example.com', 'admin');
    admin = await login(ctx, 'admin@example.com');
  });

  it('does not start the gateway, says so once, and keeps the API up', async () => {
    expect(
      errors.some((line) => line.includes('the LLM gateway did not start')),
    ).toBe(true);
    const res = await admin.get('/admin/llm');
    expect(res.status).toBe(200);
    expect((res.body as LlmSettingsView).gatewayAvailable).toBe(false);
  });

  it('refuses to store a key', async () => {
    const res = await admin.send('put', '/admin/llm/providers/anthropic/key', {
      key: ANTHROPIC_KEY,
    });
    expect(res.status).toBe(503);
    expect((res.body as LlmErrorBody).error).toBe('llm_gateway_unavailable');
    expect(
      (
        await ctx.prisma.llmProviderSetting.findUnique({
          where: { provider: 'anthropic' },
        })
      )?.keyCiphertext ?? null,
    ).toBeNull();
  });

  it('refuses every call', async () => {
    const error = await ctx.app
      .get(LlmGateway)
      .complete({
        userId: null,
        feature: 'assistant',
        provider: 'anthropic',
        request: ask(),
      })
      .catch((e: unknown) => e);
    expect((error as LlmError).code).toBe('llm_gateway_unavailable');
  });
});
