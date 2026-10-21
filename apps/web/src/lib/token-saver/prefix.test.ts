import { describe, expect, it } from 'bun:test';
import {
  budgetFill,
  lineDiff,
  mcpForType,
  pruneMcpByType,
  renderOverlayText,
  sameByType,
  setMcpForType,
  setSkillOffForType,
  sizeChange,
  skillChoices,
  unifiedDiff,
} from './prefix';

describe('lineDiff', () => {
  it('marks removed and added lines and keeps the common ones', () => {
    const diff = lineDiff('a\nb\nc', 'a\nc\nd');
    expect(unifiedDiff(diff)).toBe('  a\n- b\n  c\n+ d');
  });

  it('is empty-safe on either side', () => {
    expect(lineDiff('', '')).toEqual([]);
    expect(unifiedDiff(lineDiff('', 'x'))).toBe('+ x');
    expect(unifiedDiff(lineDiff('x', ''))).toBe('- x');
  });

  it('falls back to remove-all, add-all for a huge input', () => {
    const big = Array.from({ length: 2500 }, (_, i) => `l${i}`).join('\n');
    const other = Array.from({ length: 2500 }, (_, i) => `m${i}`).join('\n');
    const diff = lineDiff(big, other);
    expect(diff).toHaveLength(5000);
    expect(diff.slice(0, 2500).every((l) => l.kind === 'remove')).toBe(true);
  });
});

describe('renderOverlayText', () => {
  it('renders a rules overlay as the rules block', () => {
    const text = JSON.stringify({
      rules: [{ id: 'r1', title: 'No any', description: 'Use unknown.' }],
    });
    expect(renderOverlayText('rules', text)).toBe(
      '1. **No any** — Use unknown.',
    );
  });

  it('leaves other parts and malformed JSON as they are', () => {
    expect(renderOverlayText('claude_md', '# x')).toBe('# x');
    expect(renderOverlayText('rules', 'not json')).toBe('not json');
  });
});

describe('sizes', () => {
  it('computes the change and the budget fill', () => {
    expect(sizeChange(1000, 690)).toEqual({ delta: -310, percent: -31 });
    expect(sizeChange(0, 10).percent).toBe(0);
    expect(budgetFill(50_000, 25_000)).toBe(1);
    expect(budgetFill(12_500, 25_000)).toBe(0.5);
  });
});

describe('selection matrix', () => {
  const allow = ['github', 'sentry'];

  it('does not narrow a type without a list', () => {
    expect(mcpForType({}, 'bug', allow)).toEqual(allow);
  });

  it('narrows one type and drops the list once it is whole again', () => {
    const narrowed = setMcpForType({}, 'bug', 'sentry', false, allow);
    expect(narrowed).toEqual({ bug: ['github'] });
    expect(setMcpForType(narrowed, 'bug', 'sentry', true, allow)).toEqual({});
  });

  it('hides and shows skills, dropping an empty list', () => {
    const off = setSkillOffForType({}, 'ui', 'review', true);
    expect(off).toEqual({ ui: ['review'] });
    expect(setSkillOffForType(off, 'ui', 'review', false)).toEqual({});
  });

  it('prunes servers the allowlist no longer holds', () => {
    expect(pruneMcpByType({ bug: ['github', 'sentry'] }, ['github'])).toEqual({
      bug: ['github'],
    });
  });

  it('compares per-type lists regardless of order', () => {
    expect(sameByType({ bug: ['a', 'b'] }, { bug: ['b', 'a'] })).toBe(true);
    expect(sameByType({ bug: ['a'] }, {})).toBe(false);
    expect(sameByType({ bug: [] }, {})).toBe(true);
  });

  it('offers reported skills plus the ones already hidden', () => {
    expect(skillChoices(['b'], { bug: ['a'], ui: ['b'] })).toEqual(['a', 'b']);
  });
});
