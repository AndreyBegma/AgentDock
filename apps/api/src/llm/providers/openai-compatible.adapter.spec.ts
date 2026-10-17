import { LlmError } from '../llm-error';
import {
  OPENAI_PROFILE,
  OPENROUTER_PROFILE,
  OpenAiCompatibleAdapter,
  type OpenAiCompatibleProfile,
  toChatMessages,
  XAI_PROFILE,
} from './openai-compatible.adapter';
import { collect, jsonResponse, requestOf, sseResponse } from './testing';

/** Not real keys: tests never reach a provider. */
const KEYS: Record<string, string> = {
  openai: 'sk-proj-unit-test-key-0000-91bd',
  xai: 'xai-unit-test-key-0000-77aa',
  openrouter: 'sk-or-v1-unit-test-key-0000-07ce',
};

const chunk = (delta: unknown, finish: string | null = null) => ({
  data: { choices: [{ index: 0, delta, finish_reason: finish }] },
});

const STREAM = [
  chunk({ role: 'assistant', content: '' }),
  chunk({ content: 'Checking ' }),
  chunk({ content: 'now.' }),
  chunk({
    tool_calls: [
      {
        index: 0,
        id: 'call_1',
        type: 'function',
        function: { name: 'find_card', arguments: '{"que' },
      },
    ],
  }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: 'ry":"login"}' } }] }),
  chunk({}, 'tool_calls'),
  {
    data: {
      choices: [],
      usage: {
        prompt_tokens: 200,
        completion_tokens: 60,
        prompt_tokens_details: { cached_tokens: 50 },
        completion_tokens_details: { reasoning_tokens: 12 },
      },
    },
  },
  { data: '[DONE]' },
];

describe.each<[string, OpenAiCompatibleProfile, string]>([
  ['OpenAI', OPENAI_PROFILE, 'https://api.openai.com/v1'],
  ['xAI Grok', XAI_PROFILE, 'https://api.x.ai/v1'],
  ['OpenRouter', OPENROUTER_PROFILE, 'https://openrouter.ai/api/v1'],
])('OpenAiCompatibleAdapter — %s', (_label, profile, base) => {
  const key = KEYS[profile.provider];

  it('streams text, then the tool call, the usage and the stop reason', async () => {
    const fetchMock = jest.fn(async () => sseResponse(STREAM));
    const adapter = new OpenAiCompatibleAdapter(profile, fetchMock);
    const events = await collect(
      adapter.stream({
        apiKey: key,
        request: {
          model: 'some-model',
          system: 'Be brief.',
          maxTokens: 256,
          messages: [{ role: 'user', content: 'Find the login card' }],
          tools: [
            {
              name: 'find_card',
              description: 'Finds a card',
              inputSchema: { properties: { query: { type: 'string' } } },
            },
          ],
        },
      }),
    );
    expect(events).toEqual([
      { type: 'text', text: 'Checking ' },
      { type: 'text', text: 'now.' },
      {
        type: 'tool_call',
        call: { id: 'call_1', name: 'find_card', input: { query: 'login' } },
      },
      {
        type: 'usage',
        usage: {
          input: 150,
          output: 60,
          cacheRead: 50,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          reasoning: 12,
        },
      },
      { type: 'end', stopReason: 'tool_use' },
    ]);

    const [input, init] = fetchMock.mock.calls[0] as unknown as [
      unknown,
      RequestInit,
    ];
    const sent = await requestOf(input, init);
    expect(sent.url).toBe(`${base}/chat/completions`);
    expect(sent.headers.get('authorization')).toBe(`Bearer ${key}`);
    expect(sent.body).toMatchObject({
      model: 'some-model',
      stream: true,
      stream_options: { include_usage: true },
      [profile.maxTokensField]: 256,
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Find the login card' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'find_card',
            description: 'Finds a card',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
            },
          },
        },
      ],
    });
  });

  it('answers a rejected key as llm_key_rejected, without the key', async () => {
    const adapter = new OpenAiCompatibleAdapter(profile, async () =>
      jsonResponse({ error: { message: `Incorrect API key: ${key}` } }, 401),
    );
    const error = (await adapter
      .testKey(key)
      .catch((e: unknown) => e)) as LlmError;
    expect(error).toBeInstanceOf(LlmError);
    expect(error.code).toBe('llm_key_rejected');
    expect(JSON.stringify(error.getResponse())).not.toContain(key);
  });

  it('redacts a key a provider error echoes back', async () => {
    const adapter = new OpenAiCompatibleAdapter(profile, async () =>
      jsonResponse({ error: { message: `quota for ${key} exceeded` } }, 429),
    );
    const error = (await collect(
      adapter.stream({
        apiKey: key,
        request: { model: 'm', messages: [{ role: 'user', content: 'x' }] },
      }),
    ).catch((e: unknown) => e)) as LlmError;
    expect(error.code).toBe('llm_provider_error');
    expect(error.message).toContain('(429)');
    expect(error.message).not.toContain(key);
  });

  it('tests the key with a free GET that needs it', async () => {
    const fetchMock = jest.fn(async () => jsonResponse({ data: [] }));
    await new OpenAiCompatibleAdapter(profile, fetchMock).testKey(key);
    const [input, init] = fetchMock.mock.calls[0] as unknown as [
      unknown,
      RequestInit,
    ];
    const sent = await requestOf(input, init);
    expect(sent.url).toBe(`${base}${profile.testPath}`);
    expect(sent.headers.get('authorization')).toBe(`Bearer ${key}`);
  });
});

describe('toChatMessages', () => {
  it('sends images as data URLs and tool turns as tool messages', () => {
    expect(
      toChatMessages({
        model: 'm',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              { type: 'image', mediaType: 'image/jpeg', data: '/9j/4AAQ' },
            ],
          },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'f', input: { x: 1 } }],
          },
          { role: 'tool', toolCallId: 'c1', content: 'done' },
        ],
      }),
    ).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' },
          },
        ],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'f', arguments: '{"x":1}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'done' },
    ]);
  });
});

describe('a plain answer', () => {
  it('ends with `end` and counts no reasoning', async () => {
    const adapter = new OpenAiCompatibleAdapter(OPENAI_PROFILE, async () =>
      sseResponse([
        chunk({ content: 'Hi' }, 'stop'),
        { data: { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } } },
        { data: '[DONE]' },
      ]),
    );
    const events = await collect(
      adapter.stream({
        apiKey: KEYS.openai,
        request: { model: 'gpt-5.1', messages: [{ role: 'user', content: 'Hi' }] },
      }),
    );
    expect(events.at(-2)).toEqual({
      type: 'usage',
      usage: {
        input: 3,
        output: 1,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        reasoning: 0,
      },
    });
    expect(events.at(-1)).toEqual({ type: 'end', stopReason: 'end' });
  });
});
