import { STEWARD_REASON_MAX } from '@nautelle/shared';
import { sanitizeReason } from './steward-reason';

const ch = (codePoint: number): string => String.fromCodePoint(codePoint);

describe('sanitizeReason (DA-13)', () => {
  it('keeps a plain line', () => {
    expect(sanitizeReason('API Error: Connection lost mid-response')).toBe(
      'API Error: Connection lost mid-response',
    );
  });

  it('strips control and bidi characters and collapses whitespace', () => {
    const bell = ch(0x07);
    const esc = ch(0x1b);
    const override = ch(0x202e);
    const isolate = ch(0x2066);
    const zeroWidth = ch(0x200b);
    const separator = ch(0x2028);
    expect(
      sanitizeReason(
        `a${bell}b${esc}[31m  c${override}d${isolate}e${zeroWidth}f${separator}g`,
      ),
    ).toBe('a b [31m c d e f g');
    expect(sanitizeReason('one\r\ntwo\tthree')).toBe('one two three');
  });

  it('caps the length with an ellipsis', () => {
    const reason = sanitizeReason('x'.repeat(STEWARD_REASON_MAX + 50));
    expect(reason).toHaveLength(STEWARD_REASON_MAX);
    expect(reason?.endsWith('…')).toBe(true);
  });

  it('is null when nothing printable is left', () => {
    expect(sanitizeReason(`${ch(0)}${ch(0x202e)} \n`)).toBeNull();
  });
});
