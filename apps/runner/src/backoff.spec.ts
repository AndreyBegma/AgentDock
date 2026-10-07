import { describe, expect, it } from 'bun:test';
import { Backoff } from './backoff';

describe('Backoff', () => {
  it('doubles from 1 s to a 60 s ceiling without jitter', () => {
    const backoff = new Backoff({ random: () => 0.5 });
    const delays = Array.from({ length: 9 }, () => backoff.next());
    expect(delays).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000,
    ]);
  });

  it('keeps jitter within ±20 %', () => {
    expect(new Backoff({ random: () => 0 }).next()).toBe(800);
    expect(new Backoff({ random: () => 0.999_999 }).next()).toBe(1_200);
  });

  it('starts over after reset', () => {
    const backoff = new Backoff({ random: () => 0.5 });
    backoff.next();
    backoff.next();
    backoff.reset();
    expect(backoff.next()).toBe(1_000);
  });
});
