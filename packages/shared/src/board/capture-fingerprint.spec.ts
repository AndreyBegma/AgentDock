import { describe, expect, it } from 'bun:test';
import {
  CAPTURE_FINGERPRINT_PATTERN,
  captureFingerprint,
  normalizeCaptureTitle,
  sha256Hex,
} from './capture-fingerprint';

const utf8 = (text: string) => new TextEncoder().encode(text);

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 vectors', () => {
    expect(sha256Hex(utf8(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(utf8('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(
      sha256Hex(
        utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
      ),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('handles the padding boundaries and multi-block input', () => {
    // 55 and 56 bytes straddle the one-block limit; 1000 bytes is many blocks.
    expect(sha256Hex(utf8('a'.repeat(55)))).toBe(
      '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318',
    );
    expect(sha256Hex(utf8('a'.repeat(56)))).toBe(
      'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a',
    );
    expect(sha256Hex(utf8('a'.repeat(1000)))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    );
  });
});

describe('normalizeCaptureTitle', () => {
  it('lowercases, strips punctuation and collapses whitespace', () => {
    expect(normalizeCaptureTitle('  Add login-page!  ')).toBe('add login page');
    expect(normalizeCaptureTitle('add   login\tpage')).toBe('add login page');
    expect(normalizeCaptureTitle('Fix “quotes” — now…')).toBe('fix quotes now');
  });

  it('applies NFKC, so full-width letters match', () => {
    expect(normalizeCaptureTitle('Ｆｉｘ　ＢＵＧ')).toBe('fix bug');
  });

  it('keeps letters of every script', () => {
    expect(normalizeCaptureTitle('Исправить вход!')).toBe('исправить вход');
  });
});

describe('captureFingerprint', () => {
  it('is the hex sha256 of the normalized title', () => {
    expect(captureFingerprint('ABC')).toBe(sha256Hex(utf8('abc')));
    expect(captureFingerprint('Add login-page!')).toBe(
      captureFingerprint('add login page'),
    );
    expect(captureFingerprint('Add login')).not.toBe(
      captureFingerprint('Add logout'),
    );
    expect(CAPTURE_FINGERPRINT_PATTERN.test(captureFingerprint('x'))).toBe(
      true,
    );
  });
});
