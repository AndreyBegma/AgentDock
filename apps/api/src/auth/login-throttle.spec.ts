import { delayAfter, MAX_DELAY_MS, THROTTLE_AFTER } from './login-throttle';

describe('delayAfter (C-109)', () => {
  it('lets a source fail below the threshold without waiting', () => {
    for (let failures = 0; failures < THROTTLE_AFTER; failures += 1) {
      expect(delayAfter(failures)).toBe(0);
    }
  });

  it('starts at 1 s and doubles up to the 60 s ceiling', () => {
    const waits = Array.from({ length: 9 }, (_, i) =>
      delayAfter(THROTTLE_AFTER + i),
    );
    expect(waits).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000,
    ]);
    expect(delayAfter(1_000)).toBe(MAX_DELAY_MS);
  });
});
