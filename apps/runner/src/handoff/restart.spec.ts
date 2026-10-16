import { describe, expect, it } from 'bun:test';
import { CACHE_TTL_1H_MS, CACHE_TTL_5M_MS, decideRestart } from './restart';

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
