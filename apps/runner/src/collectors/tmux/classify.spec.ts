import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyPane, type PaneReading } from './classify';
import { PaneTracker } from './tracker';

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, '__fixtures__', `${name}.txt`), 'utf8');

/**
 * What `watch.sh` printed for each fixture, recorded by sourcing it and
 * running `classify_pane "$pane" <idle> 0` with idle 0 and 2, plus its quota
 * grep. Mapped back: PROMPT → dialog; NONE with the idle count reset → busy;
 * a count that grows → quiet (IDLE on the third).
 */
const WATCH_SH = {
  trust: { first: 'PROMPT 0 1', third: 'PROMPT 0 1', quota: false },
  bypass: { first: 'PROMPT 0 1', third: 'PROMPT 0 1', quota: false },
  credits: { first: 'PROMPT 0 1', third: 'PROMPT 0 1', quota: false },
  settings: { first: 'PROMPT 0 1', third: 'PROMPT 0 1', quota: false },
  busy: { first: 'NONE 0 0', third: 'NONE 0 0', quota: false },
  'empty-prompt': { first: 'NONE 1 0', third: 'IDLE 3 0', quota: false },
  quota: { first: 'NONE 1 0', third: 'IDLE 3 0', quota: true },
} as const;

/** `classify_pane`, driven by a reading: the line `watch.sh` would print. */
const asWatchSh = (reading: PaneReading, idle: number): string => {
  if (reading.kind === 'dialog') return 'PROMPT 0 1';
  if (reading.kind === 'busy') return 'NONE 0 0';
  const count = idle + 1;
  return `${count === 3 ? 'IDLE' : 'NONE'} ${count} 0`;
};

describe('classifyPane', () => {
  it.each(
    Object.entries(WATCH_SH),
  )('classifies the %s fixture as watch.sh does', (name, expected) => {
    const reading = classifyPane(fixture(name));
    expect(asWatchSh(reading, 0)).toBe(expected.first);
    expect(asWatchSh(reading, 2)).toBe(expected.third);
    expect(reading.quota).toBe(expected.quota);
  });

  it.each([
    ['trust', 'trust'],
    ['bypass', 'bypass'],
    ['credits', 'credits'],
    ['settings', 'settings'],
  ] as const)('names the %s dialog', (name, dialog) => {
    expect(classifyPane(fixture(name)).dialog).toBe(dialog);
  });
});

describe('PaneTracker', () => {
  const feed = (tracker: PaneTracker, ...names: string[]) =>
    names.flatMap((n) => tracker.next(classifyPane(fixture(n))));

  it('reports busy once, then idle on the third empty poll, once', () => {
    const tracker = new PaneTracker();
    expect(feed(tracker, 'busy', 'busy')).toEqual([{ type: 'pane.busy' }]);
    expect(feed(tracker, 'empty-prompt', 'empty-prompt')).toEqual([]);
    expect(feed(tracker, 'empty-prompt')).toEqual([
      { type: 'pane.idle', polls: 3 },
    ]);
    expect(feed(tracker, 'empty-prompt', 'empty-prompt')).toEqual([]);
    expect(feed(tracker, 'busy')).toEqual([{ type: 'pane.busy' }]);
  });

  it('reports a dialog on the poll it appears, once per occurrence', () => {
    const tracker = new PaneTracker();
    expect(feed(tracker, 'trust')).toEqual([
      { type: 'pane.prompt', dialog: 'trust' },
    ]);
    expect(feed(tracker, 'trust', 'trust')).toEqual([]);
    expect(feed(tracker, 'busy')).toEqual([{ type: 'pane.busy' }]);
    expect(feed(tracker, 'bypass')).toEqual([
      { type: 'pane.prompt', dialog: 'bypass' },
    ]);
  });

  it('holds quota while the banner stays, and leaves it on busy', () => {
    const tracker = new PaneTracker();
    expect(feed(tracker, 'quota')).toEqual([{ type: 'pane.quota_hit' }]);
    expect(feed(tracker, 'quota', 'quota', 'quota')).toEqual([]);
    expect(feed(tracker, 'busy')).toEqual([{ type: 'pane.busy' }]);
  });
});
