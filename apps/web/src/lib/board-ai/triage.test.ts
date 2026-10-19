import { describe, expect, test } from 'bun:test';
import { hintsLabel, priorityHintLabel, triageHintCount } from './triage';

describe('triage hints', () => {
  test('count duplicates once, and nothing unless ready', () => {
    const duplicate = {
      number: 12,
      label: 'C-12',
      title: 'Digest',
      column: 'todo' as const,
      reason: 'Same',
    };
    expect(
      triageHintCount({
        state: 'ready',
        duplicates: [duplicate, { ...duplicate, number: 13 }],
        kind: { value: 'bug', reason: 'Broken' },
        priority: null,
      }),
    ).toBe(2);
    expect(
      triageHintCount({
        state: 'hidden',
        duplicates: null,
        kind: null,
        priority: null,
      }),
    ).toBe(0);
  });

  test('say where a priority moves the card', () => {
    expect(priorityHintLabel('high')).toContain('top of its column');
    expect(priorityHintLabel('low')).toContain('bottom of its column');
    expect(hintsLabel(1)).toBe('1 hint');
    expect(hintsLabel(3)).toBe('3 hints');
  });
});
