import { oneLine } from './steward-digest-text';

describe('oneLine (DA-13)', () => {
  it('turns line breaks and control characters into one space', () => {
    expect(oneLine('first\nsecond\r\nthird\tfourth\u0000fifth', 100)).toBe(
      'first second third fourth fifth',
    );
    expect(oneLine('a b c\u0085d', 100)).toBe('a b c d');
  });

  it('collapses runs of whitespace and trims', () => {
    expect(oneLine('  stuck   on \n\n the   build  ', 100)).toBe(
      'stuck on the build',
    );
  });

  it('cuts to the bound with an ellipsis, counting characters not code units', () => {
    const out = oneLine('x'.repeat(300), 200);
    expect(Array.from(out)).toHaveLength(200);
    expect(out.endsWith('…')).toBe(true);
    // An emoji is one character; it is never cut in half.
    const emoji = oneLine('😀'.repeat(10), 5);
    expect(Array.from(emoji)).toEqual(['😀', '😀', '😀', '😀', '…']);
  });

  it('leaves a short single line as it is', () => {
    expect(oneLine('API Error: Connection lost', 200)).toBe(
      'API Error: Connection lost',
    );
  });

  it('is empty for text of nothing but breaks', () => {
    expect(oneLine('\n\r\t ', 10)).toBe('');
  });
});
