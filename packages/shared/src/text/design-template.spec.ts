import { describe, expect, it } from 'bun:test';
import { classifyDesignTemplateEnglish } from './deepl';
import { parseNormalizeOutput } from './normalize-contract';
import { buildNormalizePrompt } from './normalize-prompt';

describe('classifyDesignTemplateEnglish (#833 D8)', () => {
  it('reads the three titles of the spec', () => {
    expect(classifyDesignTemplateEnglish('Settings page for webhooks')).toBe(
      'page',
    );
    expect(classifyDesignTemplateEnglish('Date range picker component')).toBe(
      'component',
    );
    expect(classifyDesignTemplateEnglish('Three-step onboarding wizard')).toBe(
      'flow',
    );
  });

  it('falls back to page', () => {
    expect(classifyDesignTemplateEnglish('Add login')).toBe('page');
  });
});

describe('the design template in the normalize contract (#833 D8)', () => {
  const block = (json: object) =>
    ['```agentdock-text', JSON.stringify(json), '```'].join('\n');

  it('asks for the project’s keys with the kind, and not otherwise', () => {
    const asked = buildNormalizePrompt([], true, ['page', 'landing']);
    expect(asked).toContain('"designTemplate"');
    expect(asked).toContain('"page", "landing"');
    expect(buildNormalizePrompt([], true)).not.toContain('designTemplate');
    expect(buildNormalizePrompt([], false, ['page'])).not.toContain(
      '"designTemplate": "page"',
    );
  });

  it('accepts a designTemplate beside the kind', () => {
    const parsed = parseNormalizeOutput(
      block({ fields: [], kind: 'feature', designTemplate: 'flow' }),
      { ids: [], classifyKind: true },
    );
    expect(parsed).toMatchObject({
      ok: true,
      output: { designTemplate: 'flow' },
    });
  });
});
