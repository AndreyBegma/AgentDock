import type { TokenBuckets } from '@agentdock/shared/protocol';
import Anthropic from '@anthropic-ai/sdk';
import { LlmError } from '../llm-error';
import {
  DEFAULT_MAX_TOKENS,
  type LlmAdapter,
  type LlmAdapterCall,
  type LlmMessage,
  type LlmStopReason,
  type LlmStreamEvent,
} from '../types';
import { providerFailure, rethrowAbort } from './provider-errors';

type Fetch = typeof fetch;

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

const stopReasonOf = (reason: Anthropic.StopReason | null): LlmStopReason => {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
};

/** Anthropic's usage in the price table's buckets; `input` excludes the cache. */
export const anthropicUsage = (usage: Anthropic.Usage): TokenBuckets => {
  const written = usage.cache_creation_input_tokens ?? 0;
  const split = usage.cache_creation;
  const write1h = split?.ephemeral_1h_input_tokens ?? 0;
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite5m: split ? (split.ephemeral_5m_input_tokens ?? 0) : written,
    cacheWrite1h: write1h,
    reasoning: 0,
  };
};

/**
 * Anthropic's messages carry tool results as `tool_result` blocks of a user
 * turn; consecutive results go back in one turn, as parallel calls require.
 */
export const toAnthropicMessages = (
  messages: readonly LlmMessage[],
): Anthropic.MessageParam[] => {
  const out: Anthropic.MessageParam[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      out.push({
        role: 'user',
        content:
          typeof message.content === 'string'
            ? message.content
            : message.content.map((part) =>
                part.type === 'text'
                  ? { type: 'text', text: part.text }
                  : {
                      type: 'image',
                      source: {
                        type: 'base64',
                        media_type: part.mediaType,
                        data: part.data,
                      },
                    },
              ),
      });
    } else if (message.role === 'assistant') {
      const content: Anthropic.ContentBlockParam[] = [];
      if (message.content)
        content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.input,
        });
      }
      out.push({ role: 'assistant', content });
    } else {
      const result: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: message.content,
        ...(message.isError ? { is_error: true } : {}),
      };
      const last = out.at(-1);
      if (
        last?.role === 'user' &&
        Array.isArray(last.content) &&
        last.content.every((block) => block.type === 'tool_result')
      ) {
        last.content.push(result);
      } else {
        out.push({ role: 'user', content: [result] });
      }
    }
  }
  return out;
};

/** Anthropic through `@anthropic-ai/sdk` (ADR-0058). */
export class AnthropicAdapter implements LlmAdapter {
  readonly provider = 'anthropic' as const;

  /** `fetch` and `baseURL` are for tests, which mock the HTTP. */
  constructor(
    private readonly options: { fetch?: Fetch; baseURL?: string } = {},
  ) {}

  private client(apiKey: string): Anthropic {
    return new Anthropic({
      apiKey,
      // The gateway picks the key; nothing from the environment is used.
      authToken: null,
      maxRetries: 1,
      // Explicit, so `ANTHROPIC_BASE_URL` in the API's environment cannot redirect the key.
      baseURL: this.options.baseURL ?? ANTHROPIC_BASE_URL,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
  }

  async *stream({
    apiKey,
    request,
    signal,
  }: LlmAdapterCall): AsyncIterable<LlmStreamEvent> {
    let final: Anthropic.Message;
    const pending: LlmStreamEvent[] = [];
    try {
      const stream = this.client(apiKey).messages.stream(
        {
          model: request.model,
          max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(request.system ? { system: request.system } : {}),
          messages: toAnthropicMessages(request.messages),
          ...(request.tools?.length
            ? {
                tools: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: {
                    type: 'object' as const,
                    ...tool.inputSchema,
                  },
                })),
              }
            : {}),
        },
        { signal },
      );
      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          yield { type: 'text', text: event.delta.text };
        }
      }
      final = await stream.finalMessage();
    } catch (error) {
      throw this.failure(error, apiKey);
    }
    for (const block of final.content) {
      if (block.type === 'tool_use') {
        pending.push({
          type: 'tool_call',
          call: {
            id: block.id,
            name: block.name,
            input: (block.input ?? {}) as Record<string, unknown>,
          },
        });
      }
    }
    yield* pending;
    yield { type: 'usage', usage: anthropicUsage(final.usage) };
    yield { type: 'end', stopReason: stopReasonOf(final.stop_reason) };
  }

  async testKey(apiKey: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.client(apiKey).models.list({ limit: 1 }, { signal });
    } catch (error) {
      throw this.failure(error, apiKey);
    }
  }

  private failure(error: unknown, apiKey: string): unknown {
    rethrowAbort(error);
    if (error instanceof LlmError) return error;
    if (error instanceof Anthropic.APIError) {
      return providerFailure('anthropic', error.status, error.message, apiKey);
    }
    const message = error instanceof Error ? error.message : String(error);
    return providerFailure('anthropic', undefined, message, apiKey);
  }
}
