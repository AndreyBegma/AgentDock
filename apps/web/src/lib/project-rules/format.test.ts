import { describe, expect, test } from 'bun:test';
import type { ProjectRuleView } from '@agentdock/shared';
import {
  filterRules,
  importSummary,
  moveRule,
  workerPromptBlock,
} from './format';

const rule = (
  id: string,
  title: string,
  enabled = true,
  description = '',
): ProjectRuleView => ({
  id,
  projectId: 'p',
  title,
  description,
  enabled,
  position: 0,
  source: 'manual',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
});

describe('filterRules', () => {
  const rules = [
    rule('a', 'Bun only', true, 'Package manager'),
    rule('b', 'No any', false, 'Strict TypeScript'),
  ];
  test('filters by enabled state', () => {
    expect(filterRules(rules, '', 'enabled').map((r) => r.id)).toEqual(['a']);
    expect(filterRules(rules, '', 'disabled').map((r) => r.id)).toEqual(['b']);
  });
  test('searches title and description, ignoring case', () => {
    expect(filterRules(rules, ' TYPESCRIPT ', 'all').map((r) => r.id)).toEqual([
      'b',
    ]);
  });
});

describe('moveRule', () => {
  test('swaps with the neighbour', () => {
    expect(moveRule(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveRule(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
  });
  test('stays put at the edges', () => {
    expect(moveRule(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveRule(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });
});

describe('workerPromptBlock', () => {
  test('lists enabled rules only, numbered in order', () => {
    const block = workerPromptBlock([
      rule('a', 'One', true, 'first'),
      rule('b', 'Two', false, 'second'),
      rule('c', 'Three', true),
    ]);
    expect(block).toContain('1. **One** — first');
    expect(block).toContain('2. **Three**');
    expect(block).not.toContain('Two');
  });
  test('is empty with nothing enabled', () => {
    expect(workerPromptBlock([rule('a', 'One', false)])).toBe('');
  });
});

describe('importSummary', () => {
  test('counts created and skipped', () => {
    expect(importSummary(3, 1)).toBe(
      '3 rules created, 1 skipped as a duplicate.',
    );
    expect(importSummary(1, 2)).toBe(
      '1 rule created, 2 skipped as duplicates.',
    );
  });
});
