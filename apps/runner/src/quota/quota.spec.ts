import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyPane, detectQuota } from '../collectors/tmux/classify';
import { readPane } from '../steward/pane-rules';

const fixture = (name: string) =>
  readFileSync(
    join(import.meta.dir, '../collectors/tmux/__fixtures__', `${name}.txt`),
    'utf8',
  );

const context = { now: new Date('2026-10-21T12:00:00Z'), zone: 'UTC' };

/** One table for every reader of a pane: the Board's and the steward's. */
const BANNERS = [
  ['quota', 'weekly', '2026-10-26T09:00:00.000Z'],
  ['quota-uppercase', 'weekly', '2026-10-26T09:00:00.000Z'],
  ['quota-session', 'session', '2026-10-22T11:00:00.000Z'],
  ['quota-5hour', 'session', '2026-10-21T15:00:00.000Z'],
  ['quota-usage', 'usage', null],
] as const;

const QUIET = [['busy'], ['empty-prompt'], ['trust'], ['bypass'], ['credits']];

describe('detectQuota', () => {
  it.each(BANNERS)('reads the %s banner', (name, limit, resetsAt) => {
    expect(detectQuota(fixture(name), context)).toEqual({ limit, resetsAt });
  });

  it('calls a new wording a limit it does not know, with no reset', () => {
    expect(detectQuota("You've hit your monthly limit", context)).toEqual({
      limit: 'unknown',
      resetsAt: null,
    });
  });

  it('does not take the reset time from a later line', () => {
    const text = "You've hit your weekly limit\nthe cache resets 9am\n";
    expect(detectQuota(text, context)?.resetsAt).toBeNull();
  });
});

describe('the Board and the steward agree on a limit banner', () => {
  it.each(BANNERS)('%s', (name) => {
    const text = fixture(name);
    expect(classifyPane(text, context).quota).not.toBeNull();
    expect(readPane(text).signal?.kind).toBe('quota');
  });

  it.each(QUIET)('and on %s, which has none', (name) => {
    const text = fixture(name);
    expect(classifyPane(text, context).quota).toBeNull();
    expect(readPane(text).signal?.kind).not.toBe('quota');
  });
});
