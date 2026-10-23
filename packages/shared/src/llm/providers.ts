/**
 * The LLM providers the API calls directly (ADR-0059). Grok and OpenRouter
 * speak the OpenAI chat-completions protocol.
 */
export const LLM_PROVIDERS = [
  'anthropic',
  'openai',
  'xai',
  'openrouter',
] as const;
export type LlmProviderId = (typeof LLM_PROVIDERS)[number];

export const isLlmProvider = (value: unknown): value is LlmProviderId =>
  typeof value === 'string' &&
  (LLM_PROVIDERS as readonly string[]).includes(value);

export interface LlmProviderInfo {
  id: LlmProviderId;
  label: string;
  /** The monthly cap a new instance starts with, USD; 0 is disabled. */
  defaultCapUsd: number;
  /** Model ids offered as suggestions; any id the price table prices can be enabled. */
  suggestedModels: readonly string[];
}

export const LLM_PROVIDER_INFO: Record<LlmProviderId, LlmProviderInfo> = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    defaultCapUsd: 200,
    suggestedModels: [
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-fable-5-1',
    ],
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    defaultCapUsd: 0,
    suggestedModels: ['gpt-5.1', 'gpt-5.1-mini'],
  },
  xai: {
    id: 'xai',
    label: 'xAI Grok',
    defaultCapUsd: 0,
    suggestedModels: ['grok-4', 'grok-4-fast'],
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultCapUsd: 0,
    suggestedModels: ['anthropic/claude-sonnet-5-5', 'openai/gpt-5.1'],
  },
};

/** What a call is for — the usage ledger's feature tag. */
export const LLM_FEATURES = [
  'assistant',
  'digest',
  'summary',
  'search',
  'triage',
  'title',
  'assistant_summary',
  'review_instructions',
] as const;
export type LlmFeature = (typeof LLM_FEATURES)[number];

/** Characters of a stored key the API ever returns: its last four. */
export const LLM_KEY_SUFFIX_LENGTH = 4;

/** The masked tail of a key, e.g. `…4f2a`; null for a key too short to mask. */
export const llmKeySuffix = (key: string): string | null =>
  key.length > LLM_KEY_SUFFIX_LENGTH * 2
    ? key.slice(-LLM_KEY_SUFFIX_LENGTH)
    : null;

/**
 * Whether a model takes image input. Every current Claude, GPT-4o/4.1/5 and
 * Grok 4 model does; a model this cannot tell gets text only.
 */
export const llmModelSeesImages = (model: string): boolean =>
  /claude|gpt-4o|gpt-4\.1|gpt-5|grok-4|grok-2-vision|vision|gemini/i.test(
    model,
  );
