import { describe, expect, test } from 'bun:test';
import type { ModelPriceInput } from '@nautelle/shared';
import { groupModels, isUsed, providerOf } from './group';

const model = (
  modelName: string,
  matchPattern = modelName,
): ModelPriceInput => ({
  modelName,
  matchPattern,
  priority: 0,
  tiers: [],
});

describe('providerOf', () => {
  test('names the provider from the model family', () => {
    expect(providerOf('claude-opus-4-5')).toBe('Anthropic');
    expect(providerOf('gpt-4o-mini')).toBe('OpenAI');
    expect(providerOf('o3')).toBe('OpenAI');
    expect(providerOf('gemini-2.5-pro')).toBe('Google');
    expect(providerOf('something-else')).toBe('Other');
  });
});

describe('isUsed', () => {
  test('matches the pattern case-insensitively against the used ids', () => {
    expect(isUsed({ matchPattern: '^claude-opus' }, ['Claude-Opus-4-5'])).toBe(
      true,
    );
    expect(isUsed({ matchPattern: '^gpt' }, ['claude-opus-4-5'])).toBe(false);
  });

  test('an invalid regex matches nothing instead of throwing', () => {
    expect(isUsed({ matchPattern: '(' }, ['anything'])).toBe(false);
  });
});

describe('groupModels', () => {
  const models = [
    model('gpt-4o'),
    model('claude-opus-4-5', '^claude-opus-4-5'),
    model('zzz-unknown'),
    model('gemini-pro'),
    model('claude-haiku', '^claude-haiku'),
  ];

  test('used models come first, the rest by provider with Other last', () => {
    const { used, rest } = groupModels(models, ['claude-opus-4-5-20260101']);
    expect(used.map((m) => m.modelName)).toEqual(['claude-opus-4-5']);
    expect(rest.map((g) => g.provider)).toEqual([
      'Anthropic',
      'Google',
      'OpenAI',
      'Other',
    ]);
    expect(rest[0]?.models.map((m) => m.modelName)).toEqual(['claude-haiku']);
  });

  test('nothing used leaves everything grouped', () => {
    const { used, rest } = groupModels(models, []);
    expect(used).toEqual([]);
    expect(rest.flatMap((g) => g.models)).toHaveLength(models.length);
  });
});
