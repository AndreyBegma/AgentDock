import { describe, expect, it } from 'bun:test';
import { FakeClock } from '../testing/fake-clock';
import { APP_HEALTHY_POLL_MS, AppPacing } from './app-pacing';

const MINUTE = 60_000;

describe('AppPacing (spec 27 D12)', () => {
  it('lets every tick through without a healthy App', () => {
    const clock = new FakeClock();
    const pacing = new AppPacing(clock);
    pacing.polled();
    expect(pacing.due()).toBe(true);
    pacing.setHealth('unhealthy');
    expect(pacing.due()).toBe(true);
  });

  it('lets a tick through only every 10 minutes while healthy', () => {
    const clock = new FakeClock();
    const pacing = new AppPacing(clock);
    pacing.setHealth('healthy');
    expect(pacing.due()).toBe(true); // nothing polled yet
    pacing.polled();
    for (let minute = 1; minute < 10; minute++) {
      clock.advance(MINUTE);
      expect(pacing.due()).toBe(false);
    }
    clock.advance(MINUTE);
    expect(pacing.due()).toBe(true);
    expect(APP_HEALTHY_POLL_MS).toBe(10 * MINUTE);
  });

  it('counts a poll of any kind, and returns to every tick when health drops', () => {
    const clock = new FakeClock();
    const pacing = new AppPacing(clock);
    pacing.setHealth('healthy');
    pacing.polled();
    clock.advance(9 * MINUTE);
    pacing.polled(); // a collector.poll
    clock.advance(MINUTE);
    expect(pacing.due()).toBe(false);
    pacing.setHealth(undefined);
    expect(pacing.due()).toBe(true);
  });
});
