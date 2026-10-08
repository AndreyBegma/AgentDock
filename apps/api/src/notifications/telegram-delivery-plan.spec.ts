import { planTelegramDeliveries } from './telegram-delivery-plan';

const ids = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `d${i + 1}`);
const NOW = new Date('2026-10-08T10:00:00Z');

describe('planTelegramDeliveries (spec 22 D6)', () => {
  it('sends 20 of 30 at once and digests the other 10 at the window end', () => {
    const plan = planTelegramDeliveries({
      due: ids(30),
      usedInWindow: 0,
      oldestSentAt: null,
      now: NOW,
    });
    expect(plan.send).toEqual(ids(20));
    expect(plan.digest).toEqual(ids(30).slice(20));
    expect(plan.digestAt).toEqual(new Date('2026-10-08T10:10:00Z'));
  });

  it('counts what the window already used', () => {
    const plan = planTelegramDeliveries({
      due: ids(5),
      usedInWindow: 18,
      oldestSentAt: new Date('2026-10-08T09:55:00Z'),
      now: NOW,
    });
    expect(plan.send).toEqual(['d1', 'd2']);
    expect(plan.digest).toEqual(['d3', 'd4', 'd5']);
    // The window opened with the oldest message in it.
    expect(plan.digestAt).toEqual(new Date('2026-10-08T10:05:00Z'));
  });

  it('digests everything once the window is full', () => {
    const plan = planTelegramDeliveries({
      due: ids(2),
      usedInWindow: 25,
      oldestSentAt: new Date('2026-10-08T09:59:00Z'),
      now: NOW,
    });
    expect(plan.send).toEqual([]);
    expect(plan.digest).toEqual(ids(2));
  });
});
