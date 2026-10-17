import type { LlmProviderId } from '@agentdock/shared';
import type { TokenBuckets } from '@agentdock/shared/protocol';
import { LlmError } from '../llm-error';
import {
  DEFAULT_MAX_TOKENS,
  type LlmAdapter,
  type LlmAdapterCall,
  type LlmMessage,
  type LlmRequest,
  type LlmStopReason,
  type LlmStreamEvent,
  type LlmToolCall,
} from '../types';
import { providerFailure, rethrowAbort } from './provider-errors';

type Fetch = typeof fetch;

/** How one OpenAI-compatible provider differs from the others. */
export interface OpenAiCompatibleProfile {
  provider: LlmProviderId;
  baseUrl: string;
  /** OpenAI renamed `max_tokens`; Grok and OpenRouter still take it. */
  maxTokensField: 'max_completion_tokens' | 'max_tokens';
  /** Extra headers, e.g. OpenRouter's attribution. */
  headers?: Record<string, string>;
  /** A free GET that needs the key; OpenRouter's `/models` is public. */
  testPath: string;
}

export const OPENAI_PROFILE: OpenAiCompatibleProfile = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  maxTokensField: 'max_completion_tokens',
  testPath: '/models',
};

export const XAI_PROFILE: OpenAiCompatibleProfile = {
  provider: 'xai',
  baseUrl: 'https://api.x.ai/v1',
  maxTokensField: 'max_tokens',
  testPath: '/models',
};

export const OPENROUTER_PROFILE: OpenAiCompatibleProfile = {
  provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  maxTokensField: 'max_tokens',
  headers: { 'X-Title': 'AgentDock' },
  testPath: '/key',
};

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface ChatChunk {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: ChatUsage | null;
}

/**
 * Chat-completions usage in the price table's buckets: cached prompt tokens
 * are a cache read, not input; reasoning stays inside `output` (spec 12).
 */
export const chatUsage = (
  usage: ChatUsage | null | undefined,
): TokenBuckets => {
  const prompt = usage?.prompt_tokens ?? 0;
  const cached = Math.min(
    usage?.prompt_tokens_details?.cached_tokens ?? 0,
    prompt,
  );
  return {
    input: prompt - cached,
    output: usage?.completion_tokens ?? 0,
    cacheRead: cached,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    reasoning: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
  };
};

const stopReasonOf = (reason: string | null | undefined): LlmStopReason => {
  switch (reason) {
    case 'stop':
      return 'end';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
};

type ChatMessage = Record<string, unknown>;

export const toChatMessages = (request: LlmRequest): ChatMessage[] => {
  const out: ChatMessage[] = [];
  if (request.system) out.push({ role: 'system', content: request.system });
  for (const message of request.messages as readonly LlmMessage[]) {
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
                      type: 'image_url',
                      image_url: {
                        url: `data:${part.mediaType};base64,${part.data}`,
                      },
                    },
              ),
      });
    } else if (message.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: message.content || null,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.input),
                },
              })),
            }
          : {}),
      });
    } else {
      out.push({
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.content,
      });
    }
  }
  return out;
};

/** The `data:` payloads of a server-sent-events body, as they arrive. */
async function* sseData(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) yield line.slice(5).trimStart();
        newline = buffer.indexOf('\n');
      }
    }
    const rest = buffer.trim();
    if (rest.startsWith('data:')) yield rest.slice(5).trimStart();
  } finally {
    reader.releaseLock();
  }
}

const parseInput = (text: string): Record<string, unknown> => {
  if (text.trim() === '') return {};
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  } catch {
    // A truncated call (`length`) keeps what arrived, for the caller to refuse.
    return { _raw: text };
  }
};

/**
 * OpenAI chat completions over `fetch`, streamed. One class serves OpenAI,
 * xAI Grok and OpenRouter, which speak the same protocol (ADR-0058).
 */
export class OpenAiCompatibleAdapter implements LlmAdapter {
  readonly provider: LlmProviderId;

  /** `fetch` is for tests, which mock the HTTP. */
  constructor(
    private readonly profile: OpenAiCompatibleProfile,
    private readonly fetchFn: Fetch = (...args) => fetch(...args),
  ) {
    this.provider = profile.provider;
  }

  private headers(apiKey: string): Record<string, string> {
    return {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...this.profile.headers,
    };
  }

  async *stream({
    apiKey,
    request,
    signal,
  }: LlmAdapterCall): AsyncIterable<LlmStreamEvent> {
    const body = {
      model: request.model,
      stream: true,
      stream_options: { include_usage: true },
      [this.profile.maxTokensField]: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: toChatMessages(request),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: { type: 'object', ...tool.inputSchema },
              },
            })),
          }
        : {}),
    };

    const calls = new Map<number, { id: string; name: string; args: string }>();
    let usage: ChatUsage | null = null;
    let finish: string | null | undefined;
    try {
      const response = await this.fetchFn(
        `${this.profile.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: this.headers(apiKey),
          body: JSON.stringify(body),
          signal,
        },
      );
      if (!response.ok || !response.body) {
        throw providerFailure(
          this.provider,
          response.status,
          await response.text().catch(() => ''),
          apiKey,
        );
      }
      for await (const data of sseData(response.body)) {
        if (data === '[DONE]') break;
        let chunk: ChatChunk;
        try {
          chunk = JSON.parse(data) as ChatChunk;
        } catch {
          continue;
        }
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;
        const text = choice.delta?.content;
        if (text) yield { type: 'text', text };
        for (const part of choice.delta?.tool_calls ?? []) {
          const call = calls.get(part.index) ?? { id: '', name: '', args: '' };
          if (part.id) call.id = part.id;
          if (part.function?.name) call.name += part.function.name;
          if (part.function?.arguments) call.args += part.function.arguments;
          calls.set(part.index, call);
        }
      }
    } catch (error) {
      rethrowAbort(error);
      if (error instanceof LlmError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw providerFailure(this.provider, undefined, message, apiKey);
    }

    for (const [index, call] of [...calls.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      const toolCall: LlmToolCall = {
        id: call.id || `call_${index}`,
        name: call.name,
        input: parseInput(call.args),
      };
      yield { type: 'tool_call', call: toolCall };
    }
    yield { type: 'usage', usage: chatUsage(usage) };
    yield { type: 'end', stopReason: stopReasonOf(finish) };
  }

  async testKey(apiKey: string, signal?: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchFn(
        `${this.profile.baseUrl}${this.profile.testPath}`,
        {
          headers: this.headers(apiKey),
          signal,
        },
      );
    } catch (error) {
      rethrowAbort(error);
      const message = error instanceof Error ? error.message : String(error);
      throw providerFailure(this.provider, undefined, message, apiKey);
    }
    if (!response.ok) {
      throw providerFailure(
        this.provider,
        response.status,
        await response.text().catch(() => ''),
        apiKey,
      );
    }
  }
}
