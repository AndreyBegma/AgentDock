import { describe, expect, test } from 'bun:test';
import { describePaneError } from './format';

describe('describePaneError', () => {
  test.each([
    'forbidden',
    'not_found',
    'too_many_viewers',
  ] as const)('has a sentence for %s', (code) => {
    const sentence = describePaneError(code);
    expect(sentence.endsWith('.')).toBe(true);
    expect(sentence).not.toContain(code);
  });

  test('falls back for any other code', () => {
    expect(describePaneError('unknown_topic')).toBe(
      'The live pane could not be opened.',
    );
  });
});
