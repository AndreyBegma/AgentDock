import { describe, expect, it } from 'bun:test';
import { cardWorkerPrompt } from '../board/worker-prompt';
import {
  PROJECT_RULES_BLOCK_MAX_BYTES,
  projectRulesBlock,
  projectRulesCutMarker,
} from './prompt';

const rule = (title: string, description = '', enabled = true) => ({
  title,
  description,
  enabled,
});
const bytes = (t: string) => new TextEncoder().encode(t).length;

describe('projectRulesBlock', () => {
  it('has no block without rules', () => {
    expect(projectRulesBlock([])).toEqual({ text: null, omitted: 0 });
  });

  it('has no block when every rule is disabled', () => {
    expect(projectRulesBlock([rule('A', 'a', false)]).text).toBeNull();
  });

  it('lists one rule with its title and description', () => {
    const { text } = projectRulesBlock([rule('Use tabs', 'Always.')]);
    expect(text).toContain('## Project coding rules');
    expect(text).toContain('1. Use tabs\n   Always.');
  });

  it('lists many rules in order and skips disabled ones', () => {
    const { text } = projectRulesBlock([
      rule('First', 'one'),
      rule('Hidden', 'no', false),
      rule('Second', 'two'),
    ]) as { text: string };
    expect(text).not.toContain('Hidden');
    expect(text.indexOf('1. First')).toBeLessThan(text.indexOf('2. Second'));
  });

  it('truncates an oversized set with a marker', () => {
    const rules = Array.from({ length: 50 }, (_, i) =>
      rule(`Rule ${i}`, 'x'.repeat(1000)),
    );
    const { text, omitted } = projectRulesBlock(rules);
    expect(omitted).toBeGreaterThan(0);
    expect(text).toContain(projectRulesCutMarker(omitted));
    expect(bytes(text as string)).toBeLessThanOrEqual(
      PROJECT_RULES_BLOCK_MAX_BYTES,
    );
    expect(text).toContain('1. Rule 0');
  });
});

describe('cardWorkerPrompt with rules', () => {
  const base = {
    number: 1,
    title: 't',
    body: 'b',
    kind: 'feature' as const,
    branch: 'x',
    base: 'develop',
    specPath: null,
    issueNumber: null,
    design: null,
  };

  it('carries the block before the card, and omits it by default', () => {
    const { text } = projectRulesBlock([rule('Use tabs')]);
    const withRules = cardWorkerPrompt({ ...base, projectRules: text });
    expect(withRules).toContain('## Project coding rules');
    expect(withRules.indexOf('## Project coding rules')).toBeLessThan(
      withRules.indexOf('## Card C-1'),
    );
    expect(cardWorkerPrompt(base)).not.toContain('Project coding rules');
  });
});
