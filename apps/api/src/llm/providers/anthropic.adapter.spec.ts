import { LlmError } from '../llm-error';
import { AnthropicAdapter, toAnthropicMessages } from './anthropic.adapter';
import { collect, jsonResponse, requestOf, sseResponse } from './testing';

/** Not a real key: tests never reach Anthropic. */
const KEY = 'sk-ant-unit-test-key-0000-abcd';

const STREAM = [
  {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 120,
          output_tokens: 1,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 30,
          cache_creation: {
            ephemeral_5m_input_tokens: 20,
            ephemeral_1h_input_tokens: 10,
          },
        },
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
      delta: { type: 'text_delta', text: 'Looking ' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'it up.' },
    },
  },
  {
    event: 'content_block_stop',
    data: { type: 'content_block_stop', index: 0 },
  },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'find_card',
        input: {},
      },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"query":' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '"login"}' },
    },
  },
  {
    event: 'content_block_stop',
    data: { type: 'content_block_stop', index: 1 },
  },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 55 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
];

describe('AnthropicAdapter', () => {
  it('streams text, then the tool call, the usage and the stop reason', async () => {
    const fetchMock = jest.fn(async () => sseResponse(STREAM));
    const adapter = new AnthropicAdapter({ fetch: fetchMock });
    const events = await collect(
      adapter.stream({
        apiKey: KEY,
        request: {
          model: 'claude-opus-5-5',
          system: 'Be brief.',
          maxTokens: 512,
          messages: [{ role: 'user', content: 'Find the login card' }],
          tools: [
            {
              name: 'find_card',
              description: 'Finds a card',
              inputSchema: {
                properties: { query: { type: 'string' } },
                required: ['query'],
              },
            },
          ],
        },
      }),
    );
    expect(events).toEqual([
      { type: 'text', text: 'Looking ' },
      { type: 'text', text: 'it up.' },
      {
        type: 'tool_call',
        call: { id: 'toolu_1', name: 'find_card', input: { query: 'login' } },
      },
      {
        type: 'usage',
        usage: {
          input: 120,
          output: 55,
          cacheRead: 40,
          cacheWrite5m: 20,
          cacheWrite1h: 10,
          reasoning: 0,
        },
      },
      { type: 'end', stopReason: 'tool_use' },
    ]);

    const [input, init] = fetchMock.mock.calls[0] as unknown as [
      unknown,
      RequestInit,
    ];
    const sent = await requestOf(input, init);
    expect(sent.url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent.headers.get('x-api-key')).toBe(KEY);
    expect(sent.body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 512,
      system: 'Be brief.',
      stream: true,
      tools: [
        {
          name: 'find_card',
          description: 'Finds a card',
          input_schema: {
            type: 'object',
            properties: { query: { type: 'string' } },
          },
        },
      ],
    });
  });

  it('sends images as base64 blocks and tool results in one user turn', () => {
    expect(
      toAnthropicMessages([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
          ],
        },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'a', name: 'f', input: { x: 1 } },
            { id: 'b', name: 'f', input: { x: 2 } },
          ],
        },
        { role: 'tool', toolCallId: 'a', content: 'one' },
        { role: 'tool', toolCallId: 'b', content: 'bad', isError: true },
      ]),
    ).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'iVBORw0KGgo=',
            },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'a', name: 'f', input: { x: 1 } },
          { type: 'tool_use', id: 'b', name: 'f', input: { x: 2 } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'one' },
          {
            type: 'tool_result',
            tool_use_id: 'b',
            content: 'bad',
            is_error: true,
          },
        ],
      },
    ]);
  });

  it('caches the stable prefix: the system block and the last tool, not the tail', async () => {
    const fetchMock = jest.fn(async () => sseResponse(STREAM));
    const adapter = new AnthropicAdapter({ fetch: fetchMock });
    const tool = (name: string) => ({
      name,
      description: name,
      inputSchema: { properties: {} },
    });
    await collect(
      adapter.stream({
        apiKey: KEY,
        request: {
          model: 'claude-opus-5-5',
          system: 'Stable.',
          systemTail: 'Today is Monday.',
          cachePrefix: true,
          messages: [{ role: 'user', content: 'hi' }],
          tools: [tool('a'), tool('b')],
        },
      }),
    );
    const [input, init] = fetchMock.mock.calls[0] as unknown as [
      unknown,
      RequestInit,
    ];
    const { body } = await requestOf(input, init);
    expect(body?.system).toEqual([
      { type: 'text', text: 'Stable.', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Today is Monday.' },
    ]);
    const tools = body?.tools as { cache_control?: unknown }[];
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('joins the tail into one plain system string when nothing is cached', async () => {
    const fetchMock = jest.fn(async () => sseResponse(STREAM));
    const adapter = new AnthropicAdapter({ fetch: fetchMock });
    await collect(
      adapter.stream({
        apiKey: KEY,
        request: {
          model: 'claude-opus-5-5',
          system: 'Stable.',
          systemTail: 'Tail.',
          messages: [{ role: 'user', content: 'hi' }],
        },
      }),
    );
    const [input, init] = fetchMock.mock.calls[0] as unknown as [
      unknown,
      RequestInit,
    ];
    expect((await requestOf(input, init)).body?.system).toBe(
      'Stable.\n\nTail.',
    );
  });

  it('answers a rejected key as llm_key_rejected, without the key', async () => {
    const adapter = new AnthropicAdapter({
      fetch: async () =>
        jsonResponse(
          {
            type: 'error',
            error: { type: 'authentication_error', message: `bad key ${KEY}` },
          },
          401,
        ),
    });
    const error = await adapter.testKey(KEY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).code).toBe('llm_key_rejected');
    expect(JSON.stringify((error as LlmError).getResponse())).not.toContain(
      KEY,
    );
  });

  it('redacts a key a provider error echoes back', async () => {
    const adapter = new AnthropicAdapter({
      fetch: async () =>
        jsonResponse(
          {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: `key ${KEY} is odd`,
            },
          },
          400,
        ),
    });
    const error = (await collect(
      adapter.stream({
        apiKey: KEY,
        request: {
          model: 'claude-opus-5-5',
          messages: [{ role: 'user', content: 'x' }],
        },
      }),
    ).catch((e: unknown) => e)) as LlmError;
    expect(error.code).toBe('llm_provider_error');
    expect(error.message).not.toContain(KEY);
    expect(error.message).toContain('[redacted]');
  });

  it('tests a key against the models list, which costs nothing', async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse({
        data: [],
        has_more: false,
        first_id: null,
        last_id: null,
      }),
    );
    await new AnthropicAdapter({ fetch: fetchMock }).testKey(KEY);
    const [input, init] = fetchMock.mock.calls[0] as unknown as [
      unknown,
      RequestInit,
    ];
    expect((await requestOf(input, init)).url).toContain('/v1/models');
  });
});
