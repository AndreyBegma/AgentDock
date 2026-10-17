import type { LlmFeature, LlmProviderId } from '@agentdock/shared';
import type { TokenBuckets } from '@agentdock/shared/protocol';

/** Image input: base64 bytes of one of the types every provider accepts. */
export type LlmImageMediaType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp';

export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: LlmImageMediaType; data: string };

export interface LlmToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type LlmMessage =
  | { role: 'user'; content: string | LlmContentPart[] }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string; isError?: boolean };

export interface LlmTool {
  name: string;
  description: string;
  /** JSON Schema of the tool's input object. */
  inputSchema: Record<string, unknown>;
}

/** One model call, the same for every provider. */
export interface LlmRequest {
  model: string;
  system?: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  maxTokens?: number;
}

export type LlmStopReason =
  | 'end'
  | 'tool_use'
  | 'max_tokens'
  | 'refusal'
  | 'other';

/**
 * What a stream yields, in order: text as it arrives, each tool call once
 * whole, the usage, then `end`.
 */
export type LlmStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: LlmToolCall }
  | { type: 'usage'; usage: TokenBuckets }
  | { type: 'end'; stopReason: LlmStopReason };

export interface LlmAdapterCall {
  apiKey: string;
  request: LlmRequest;
  signal?: AbortSignal;
}

/**
 * One provider. Every adapter streams, passes tools and images, and reports
 * usage in the price table's token buckets (ADR-0009). Errors are thrown as
 * `LlmError`, with the key redacted.
 */
export interface LlmAdapter {
  readonly provider: LlmProviderId;
  stream(call: LlmAdapterCall): AsyncIterable<LlmStreamEvent>;
  /** A call that costs nothing, to prove the key works. */
  testKey(apiKey: string, signal?: AbortSignal): Promise<void>;
}

/** A call through the gateway: who it is for and what it is for. */
export interface LlmCallInput {
  userId: string | null;
  feature: LlmFeature;
  provider: LlmProviderId;
  request: LlmRequest;
  signal?: AbortSignal;
}

/** A finished call, collected from its stream. */
export interface LlmCompletion {
  text: string;
  toolCalls: LlmToolCall[];
  usage: TokenBuckets;
  stopReason: LlmStopReason;
  /** Decimal string, USD. */
  costUsd: string;
}

export const emptyUsage = (): TokenBuckets => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  reasoning: 0,
});

/** `max_tokens` of a call that names none. */
export const DEFAULT_MAX_TOKENS = 16_000;
