import { describe, expect, it } from 'bun:test';
import {
  cleanSessionMessage,
  SESSION_MESSAGE_MAX_CHARS,
  sessionMessageInputSchema,
} from './contracts';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

describe('cleanSessionMessage (#489 M1)', () => {
  it('strips CSI, OSC and other escape sequences', () => {
    expect(cleanSessionMessage(`${ESC}[31mred${ESC}[0m text`)).toBe('red text');
    expect(cleanSessionMessage(`a${ESC}]0;title${BEL}b`)).toBe('ab');
    expect(cleanSessionMessage(`a${ESC}]8;;http://x${ESC}\\b`)).toBe('ab');
    expect(cleanSessionMessage(`a${ESC}Pq#0;2${ESC}\\b`)).toBe('ab');
    expect(cleanSessionMessage(`up${ESC}[A${ESC}[Bdown`)).toBe('updown');
    expect(cleanSessionMessage(`x${ESC}Oy`)).toBe('xy');
  });

  it('strips control characters, C1 and DEL; a line break or tab is a space', () => {
    const controls = Array.from({ length: 32 }, (_, i) =>
      String.fromCharCode(i),
    )
      .filter((c) => !'\n\r\t\v\f\u001b'.includes(c))
      .join('');
    expect(cleanSessionMessage(`a${controls}b\u007f\u0090c\u009b1Ad`)).toBe(
      'abcd',
    );
    expect(cleanSessionMessage('one\ntwo\r\nthree\tfour')).toBe(
      'one two three four',
    );
    expect(cleanSessionMessage('\u0003\u0004')).toBe('');
  });

  it('strips zero-width and bidi characters, collapses spaces and trims', () => {
    expect(cleanSessionMessage('  a​‮b   c  ')).toBe('ab c');
  });

  it('caps the length', () => {
    const long = 'x'.repeat(SESSION_MESSAGE_MAX_CHARS + 50);
    expect(cleanSessionMessage(long)).toHaveLength(SESSION_MESSAGE_MAX_CHARS);
  });

  it('keeps ordinary text, emoji and other scripts as they are', () => {
    const text = 'Use the Toolbar — пожалуйста 👍 "quoted" $(id) `x`';
    expect(cleanSessionMessage(text)).toBe(text);
  });
});

describe('sessionMessageInputSchema', () => {
  it('refuses text that is not clean, and keystrokes in any form', () => {
    expect(
      sessionMessageInputSchema.safeParse({ kind: 'text', text: 'go on' })
        .success,
    ).toBe(true);
    for (const text of ['', `a${ESC}[A`, 'a\nb', ' a']) {
      expect(
        sessionMessageInputSchema.safeParse({ kind: 'text', text }).success,
      ).toBe(false);
    }
    expect(
      sessionMessageInputSchema.safeParse({ kind: 'keys', keys: ['C-c'] })
        .success,
    ).toBe(false);
  });

  it('takes an option by its number and a typed answer, each naming its screen', () => {
    const questionKey = '0123456789abcdef';
    expect(
      sessionMessageInputSchema.safeParse({
        kind: 'option',
        questionKey,
        index: 2,
      }).success,
    ).toBe(true);
    expect(
      sessionMessageInputSchema.safeParse({
        kind: 'other',
        questionKey,
        text: 'Neither',
      }).success,
    ).toBe(true);
    expect(
      sessionMessageInputSchema.safeParse({ kind: 'option', index: 2 }).success,
    ).toBe(false);
  });
});
