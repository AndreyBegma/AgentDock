import { describe, expect, test } from 'bun:test';
import { CARD_MERGE_POLICIES } from '@nautelle/shared';
import { MERGE_POLICY_OPTIONS, mergePolicyLabel } from './merge-policy';

describe('merge policy options', () => {
  test('offer every policy exactly once, Ask first', () => {
    expect(MERGE_POLICY_OPTIONS.map((o) => o.value)).toEqual([
      'ask',
      'agent',
      'person',
    ]);
    expect([...MERGE_POLICY_OPTIONS.map((o) => o.value)].sort()).toEqual(
      [...CARD_MERGE_POLICIES].sort(),
    );
  });

  test('read as the spec words them', () => {
    expect(mergePolicyLabel('ask')).toBe('Ask at the start of each run');
    expect(mergePolicyLabel('agent')).toBe('The agent merges');
    expect(mergePolicyLabel('person')).toBe('A person merges');
  });
});
