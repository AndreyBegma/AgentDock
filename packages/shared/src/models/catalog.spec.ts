import { describe, expect, it } from 'bun:test';
import { ORCHESTRATOR_DEFAULTS } from '../protocol/commands/control';
import {
  CLAUDE_MODEL_ALIASES,
  CLAUDE_MODELS,
  claudeModelLabel,
  claudeModelOptions,
  isClaudeModelAlias,
} from './catalog';

describe('CLAUDE_MODELS', () => {
  it('lists the aliases in order, with their labels (D4)', () => {
    expect(CLAUDE_MODELS.map((m) => [m.alias, m.label])).toEqual([
      ['opus', 'Opus 5.5'],
      ['sonnet', 'Sonnet 5.5'],
      ['haiku', 'Haiku 5.5'],
      ['fable', 'Fable 5.1'],
    ]);
    expect(CLAUDE_MODEL_ALIASES).toEqual(['opus', 'sonnet', 'haiku', 'fable']);
  });

  it('holds the orchestrator default', () => {
    expect(isClaudeModelAlias(ORCHESTRATOR_DEFAULTS.model)).toBe(true);
  });

  it('knows aliases only, never a full id or a variant', () => {
    expect(isClaudeModelAlias('sonnet')).toBe(true);
    expect(isClaudeModelAlias('claude-opus-5-5')).toBe(false);
    expect(isClaudeModelAlias('opus[1m]')).toBe(false);
    expect(isClaudeModelAlias('Opus')).toBe(false);
  });
});

describe('claudeModelLabel', () => {
  it('labels an alias, and shows anything else as stored', () => {
    expect(claudeModelLabel('opus')).toBe('Opus 5.5');
    expect(claudeModelLabel('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(claudeModelLabel('opus[1m]')).toBe('opus[1m]');
  });
});

describe('claudeModelOptions', () => {
  it('is the catalog, without a recommendation', () => {
    const options = claudeModelOptions({});
    expect(options.map((o) => o.label)).toEqual([
      'Opus 5.5',
      'Sonnet 5.5',
      'Haiku 5.5',
      'Fable 5.1',
    ]);
    expect(options.every((o) => o.inCatalog && !o.recommended)).toBe(true);
  });

  it('suffixes the recommended option (D2)', () => {
    const options = claudeModelOptions({
      selected: 'sonnet',
      recommended: 'sonnet',
    });
    expect(options.find((o) => o.value === 'sonnet')).toEqual({
      value: 'sonnet',
      label: 'Sonnet 5.5 (recommended)',
      inCatalog: true,
      recommended: true,
    });
    expect(options.filter((o) => o.recommended)).toHaveLength(1);
  });

  it('lists a stored value outside the catalog as its own option (D4)', () => {
    const options = claudeModelOptions({
      selected: 'claude-opus-5-5',
      recommended: 'opus',
    });
    expect(options[0]).toEqual({
      value: 'claude-opus-5-5',
      label: 'claude-opus-5-5',
      inCatalog: false,
      recommended: false,
    });
    expect(options).toHaveLength(CLAUDE_MODELS.length + 1);
    expect(options[1].label).toBe('Opus 5.5 (recommended)');
  });

  it('adds nothing for a catalog value, null or a blank', () => {
    for (const selected of ['haiku', null, '', '  ']) {
      expect(claudeModelOptions({ selected })).toHaveLength(
        CLAUDE_MODELS.length,
      );
    }
  });
});
