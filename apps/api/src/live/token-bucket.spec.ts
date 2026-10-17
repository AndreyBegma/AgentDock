import { TokenBucket } from './token-bucket';

describe('TokenBucket', () => {
  it('allows the burst at once, then nothing until it refills', () => {
    const bucket = new TokenBucket(20, 50, 0);
    let taken = 0;
    while (bucket.take(0)) taken += 1;
    expect(taken).toBe(50);
    expect(bucket.take(49)).toBe(false);
    expect(bucket.take(50)).toBe(true);
    expect(bucket.take(50)).toBe(false);
  });

  it('refills at the rate and never above the burst', () => {
    const bucket = new TokenBucket(20, 50, 0);
    for (let i = 0; i < 50; i += 1) bucket.take(0);
    let taken = 0;
    while (bucket.take(1_000)) taken += 1;
    expect(taken).toBe(20);
    taken = 0;
    while (bucket.take(60_000)) taken += 1;
    expect(taken).toBe(50);
  });

  it('keeps up with a steady client at the rate', () => {
    const bucket = new TokenBucket(20, 50, 0);
    for (let at = 0; at < 10_000; at += 50) {
      expect(bucket.take(at)).toBe(true);
    }
  });
});
