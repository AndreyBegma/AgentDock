import { describe, expect, it } from 'bun:test';
import {
  CACHE_TTL_1H_MS,
  CACHE_TTL_5M_MS,
  decideRestart,
  RESUME_BY_SIZE_TOKENS,
} from './restart';

const now = Date.parse('2026-10-16T12:00:00.000Z');

describe('the restart decision (#449 D3)', () => {
  it('resumes a warm session with a short history', () => {
    const stats = {
      historyTokens: 40_000,
      lastTurnAt: now - 60_000,
      cache1h: false,
    };
    expect(decideRestart(stats, 9_000, now)).toEqual({
      mode: 'resume',
      estimate: { resumeTokens: 40_000, freshTokens: 9_000, cacheWarm: true },
    });
  });

  it('starts fresh when the cache is cold and the history long', () => {
    const stats = {
      historyTokens: 180_000,
      lastTurnAt: now - 3 * 60 * 60_000,
      cache1h: false,
    };
    expect(decideRestart(stats, 12_000, now)).toEqual({
      mode: 'fresh',
      estimate: {
        resumeTokens: 180_000,
        freshTokens: 12_000,
        cacheWarm: false,
      },
    });
  });

  it('keeps 1-hour cache warm past 5 minutes', () => {
    const at = now - CACHE_TTL_5M_MS - 1;
    const short = { historyTokens: 100_000, lastTurnAt: at, cache1h: false };
    const long = { ...short, cache1h: true };
    expect(decideRestart(short, 20_000, now).mode).toBe('fresh');
    expect(decideRestart(long, 20_000, now)).toMatchObject({
      mode: 'resume',
      estimate: { cacheWarm: true },
    });
    expect(
      decideRestart({ ...long, lastTurnAt: now - CACHE_TTL_1H_MS }, 20_000, now)
        .mode,
    ).toBe('fresh');
  });

  it('resumes when a fresh start is not possible', () => {
    const stats = { historyTokens: 500_000, lastTurnAt: null, cache1h: false };
    expect(decideRestart(stats, null, now)).toEqual({
      mode: 'resume',
      estimate: { resumeTokens: 500_000, freshTokens: 0, cacheWarm: false },
    });
  });
});

describe('the size rule (#749 D3)', () => {
  const warm = (historyTokens: number) => ({
    historyTokens,
    lastTurnAt: now - 60_000,
    cache1h: false,
  });
  const bySize = { resumeBySize: true };

  it('is 60,000 tokens of history by default (D4)', () => {
    expect(RESUME_BY_SIZE_TOKENS).toBe(60_000);
  });

  it('starts a warm session of 60,000 history tokens fresh, recording both estimates', () => {
    expect(decideRestart(warm(60_000), 9_000, now, bySize)).toEqual({
      mode: 'fresh',
      estimate: { resumeTokens: 60_000, freshTokens: 9_000, cacheWarm: true },
    });
  });

  it('leaves 59,999 tokens to #449 D3: warm with a small seed resumes', () => {
    expect(decideRestart(warm(59_999), 9_000, now, bySize).mode).toBe('resume');
    // D3 still starts fresh where the first turn is cheaper that way.
    expect(decideRestart(warm(59_999), 5_000, now, bySize).mode).toBe('fresh');
  });

  it('resumes when there is no seed, however long the history', () => {
    expect(decideRestart(warm(500_000), null, now, bySize)).toEqual({
      mode: 'resume',
      estimate: { resumeTokens: 500_000, freshTokens: 0, cacheWarm: true },
    });
  });

  it('starts fresh even when the seed is larger than the warm first turn', () => {
    expect(decideRestart(warm(60_000), 15_000, now, bySize).mode).toBe('fresh');
  });

  it('does nothing when off or absent (D7)', () => {
    for (const rules of [undefined, {}, { resumeBySize: false }]) {
      expect(decideRestart(warm(80_000), 9_000, now, rules).mode).toBe(
        'resume',
      );
    }
  });
});
