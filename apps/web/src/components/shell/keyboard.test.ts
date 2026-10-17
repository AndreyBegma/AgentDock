import { describe, expect, test } from 'bun:test';
import { keyboardOpen } from './keyboard';

describe('keyboardOpen', () => {
  test('a keyboard takes hundreds of px of the visual viewport', () => {
    expect(keyboardOpen(812, 521)).toBe(true);
  });

  test('a pinch zoom shortens the visual viewport too, and is not a keyboard', () => {
    expect(keyboardOpen(812, 541, 1.5)).toBe(false);
  });

  test('a collapsing browser bar does not count', () => {
    expect(keyboardOpen(812, 760)).toBe(false);
  });
});
