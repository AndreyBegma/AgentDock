import { beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QuotaReading } from '../collectors/tmux/classify';
import { FakeClock } from '../testing/fake-clock';
import { memoryLogger } from '../testing/fixtures';
import { QuotaResumer, RESUME_GRACE_MS, type ResumeTarget } from './resume';

const banner = readFileSync(
  join(import.meta.dir, '../collectors/tmux/__fixtures__/quota.txt'),
  'utf8',
);
const busy = readFileSync(
  join(import.meta.dir, '../collectors/tmux/__fixtures__/busy.txt'),
  'utf8',
);

const START = Date.parse('2026-10-21T12:00:00Z');
const HOUR = 3_600_000;
const quota = (resetsAt: string | null): QuotaReading => ({
  limit: 'weekly',
  resetsAt,
});
/** Lets the timer's async work finish. */
const settle = () => Bun.sleep(0);

describe('QuotaResumer', () => {
  let clock: FakeClock;
  let resumer: QuotaResumer;
  let pane: string | null;
  let typed: string[];
  let resumed: number;
  let target: ResumeTarget;
  const observe = (key: string, reading: QuotaReading | null) =>
    resumer.observe(key, reading, target, () => {
      resumed += 1;
    });

  beforeEach(() => {
    clock = new FakeClock(START);
    resumer = new QuotaResumer(clock, memoryLogger().log);
    pane = banner;
    typed = [];
    resumed = 0;
    target = {
      capture: async () => pane,
      type: async (text) => {
        typed.push(text);
      },
    };
  });

  it('types continue once, a minute after the reset, and says so', async () => {
    observe('i1', quota(new Date(START + HOUR).toISOString()));
    clock.advance(HOUR + RESUME_GRACE_MS - 1);
    await settle();
    expect(typed).toEqual([]);

    clock.advance(1);
    await settle();
    expect(typed).toEqual(['continue']);
    expect(resumed).toBe(1);

    // The banner is still on screen: the same one is not tried again.
    for (let i = 0; i < 3; i += 1) observe('i1', quota('2026-10-21T13:00:00Z'));
    clock.advance(10 * HOUR);
    await settle();
    expect(typed).toEqual(['continue']);
  });

  it('sends nothing when the banner is gone by then', async () => {
    observe('i1', quota(new Date(START + HOUR).toISOString()));
    pane = busy;
    clock.advance(HOUR + RESUME_GRACE_MS);
    await settle();
    expect(typed).toEqual([]);
    expect(resumed).toBe(0);
  });

  it('sends nothing when the pane cannot be read', async () => {
    observe('i1', quota(new Date(START + HOUR).toISOString()));
    pane = null;
    clock.advance(HOUR + RESUME_GRACE_MS);
    await settle();
    expect(typed).toEqual([]);
  });

  it('does not arm a banner with no reset time', async () => {
    observe('i1', quota(null));
    expect(clock.pending()).toEqual([]);
    clock.advance(30 * 24 * HOUR);
    await settle();
    expect(typed).toEqual([]);
  });

  it('resumes at once a reset that has passed (a restarted runner)', async () => {
    observe('i1', quota(new Date(START - HOUR).toISOString()));
    clock.advance(0);
    await settle();
    expect(typed).toEqual(['continue']);
  });

  it('cancels when the banner leaves, and arms a later one afresh', async () => {
    observe('i1', quota(new Date(START + HOUR).toISOString()));
    observe('i1', null);
    expect(clock.pending()).toEqual([]);
    observe('i1', quota(new Date(START + 2 * HOUR).toISOString()));
    clock.advance(2 * HOUR + RESUME_GRACE_MS);
    await settle();
    expect(typed).toEqual(['continue']);
  });

  it('keeps each pane to itself', async () => {
    observe('a', quota(new Date(START + HOUR).toISOString()));
    observe('b', quota(new Date(START + 2 * HOUR).toISOString()));
    resumer.forget('b');
    clock.advance(3 * HOUR);
    await settle();
    expect(typed).toEqual(['continue']);
  });

  it('logs a failed send and does not retry it', async () => {
    const { log, lines } = memoryLogger();
    resumer = new QuotaResumer(clock, log);
    target.type = async () => {
      throw new Error('tmux send-keys failed');
    };
    observe('i1', quota(new Date(START + HOUR).toISOString()));
    clock.advance(HOUR + RESUME_GRACE_MS);
    await settle();
    expect(resumed).toBe(0);
    expect(JSON.stringify(lines)).toContain('could not resume');
    observe('i1', quota('2026-10-21T13:00:00Z'));
    expect(clock.pending()).toEqual([]);
  });
});
