import {
  checkSafePattern,
  compileMatchPattern,
  type ModelPriceInput,
  testBounded,
} from '@nautelle/shared';

/** Provider by the name's family; the price list itself carries no provider. */
const PROVIDERS: { provider: string; pattern: RegExp }[] = [
  { provider: 'Anthropic', pattern: /claude|anthropic/i },
  {
    provider: 'OpenAI',
    pattern:
      /gpt|openai|\bo[1-9]\b|codex|davinci|whisper|dall-e|text-embedding/i,
  },
  { provider: 'Google', pattern: /gemini|gemma|palm|google|vertex/i },
  { provider: 'Mistral', pattern: /mistral|mixtral|codestral|pixtral/i },
  { provider: 'Meta', pattern: /llama/i },
  { provider: 'xAI', pattern: /grok|xai/i },
  { provider: 'DeepSeek', pattern: /deepseek/i },
  { provider: 'Cohere', pattern: /cohere|command-/i },
  { provider: 'Amazon', pattern: /nova|titan|amazon/i },
];

export const OTHER_PROVIDER = 'Other';

export function providerOf(modelName: string): string {
  return (
    PROVIDERS.find(({ pattern }) => pattern.test(modelName))?.provider ??
    OTHER_PROVIDER
  );
}

/** A model's pattern matches a model id the account has used. A bad or unsafe regex matches nothing. */
export function isUsed(
  model: Pick<ModelPriceInput, 'matchPattern'>,
  usedModels: readonly string[],
): boolean {
  if (!checkSafePattern(model.matchPattern, 'i').ok) return false;
  try {
    const pattern = compileMatchPattern(model.matchPattern);
    return usedModels.some((used) => testBounded(pattern, used));
  } catch {
    return false;
  }
}

export interface ProviderGroup {
  provider: string;
  models: ModelPriceInput[];
}

export interface GroupedModels {
  /** Models whose pattern matches something the account has used, first. */
  used: ModelPriceInput[];
  /** Everything else by provider, providers alphabetically, "Other" last. */
  rest: ProviderGroup[];
}

export function groupModels(
  models: readonly ModelPriceInput[],
  usedModels: readonly string[],
): GroupedModels {
  const used: ModelPriceInput[] = [];
  const byProvider = new Map<string, ModelPriceInput[]>();
  for (const model of models) {
    if (isUsed(model, usedModels)) {
      used.push(model);
      continue;
    }
    const provider = providerOf(model.modelName);
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), model]);
  }
  const rest = [...byProvider.entries()]
    .map(([provider, list]) => ({
      provider,
      models: list.sort((a, b) => a.modelName.localeCompare(b.modelName)),
    }))
    .sort((a, b) =>
      a.provider === OTHER_PROVIDER
        ? 1
        : b.provider === OTHER_PROVIDER
          ? -1
          : a.provider.localeCompare(b.provider),
    );
  return { used, rest };
}
