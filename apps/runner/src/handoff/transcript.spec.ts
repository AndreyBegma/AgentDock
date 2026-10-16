import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../testing/fixtures';
import { assistantLine, userLine } from './testing';
import {
  findTranscript,
  transcriptExcerpt,
  transcriptStats,
  warmupTokens,
} from './transcript';

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups) fn();
  cleanups = [];
});

const jsonl = [
  userLine('2026-10-16T10:00:00.000Z', 'Build the login page.'),
  assistantLine({
    at: '2026-10-16T10:00:05.000Z',
    id: 'm1',
    input: 10,
    cacheRead: 1000,
    cacheWrite: 500,
    text: 'Reading the router first.',
    tools: ['Read'],
  }),
  // A message is written as several lines: its usage counts once.
  assistantLine({
    at: '2026-10-16T10:00:05.100Z',
    id: 'm1',
    input: 10,
    cacheRead: 1000,
    cacheWrite: 500,
    tools: ['Grep'],
  }),
  assistantLine({
    at: '2026-10-16T10:00:09.000Z',
    id: 'sub',
    input: 99_999,
    sidechain: true,
  }),
  assistantLine({
    at: '2026-10-16T10:00:20.000Z',
    id: 'm2',
    input: 20,
    cacheRead: 1500,
    cacheWrite: 300,
    tools: ['Edit'],
  }),
  assistantLine({
    at: '2026-10-16T10:01:00.000Z',
    id: 'm3',
    input: 5,
    cacheRead: 2000,
    cacheWrite: 100,
    text: 'Done with the form.',
  }),
  'not json',
].join('\n');

describe('the transcript (#449 D3, D9)', () => {
  it('finds a session under any project directory', () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    mkdirSync(join(dir, '-srv-app'), { recursive: true });
    writeFileSync(join(dir, '-srv-app', 'abc.jsonl'), '');
    expect(findTranscript(dir, 'abc')).toBe(join(dir, '-srv-app', 'abc.jsonl'));
    expect(findTranscript(dir, 'nope')).toBeNull();
    expect(findTranscript(join(dir, 'missing'), 'abc')).toBeNull();
  });

  it('reads the history size, the last turn and the cache lifetime', () => {
    expect(transcriptStats(jsonl)).toEqual({
      historyTokens: 2105,
      lastTurnAt: Date.parse('2026-10-16T10:01:00.000Z'),
      cache1h: false,
    });
    const oneHour = assistantLine({
      at: '2026-10-16T10:00:00.000Z',
      id: 'x',
      cacheWrite: 10,
      cacheWrite1h: 10,
    });
    expect(transcriptStats(oneHour).cache1h).toBe(true);
  });

  it('counts the warm-up up to the first file edit, each message once', () => {
    const since = Date.parse('2026-10-16T10:00:00.000Z');
    expect(warmupTokens(jsonl, since)).toBe(1510 + 1820);
    // Turns before the round started are not its warm-up.
    expect(warmupTokens(jsonl, Date.parse('2026-10-16T10:00:10.000Z'))).toBe(
      1820,
    );
    // No edit yet: the whole round so far.
    expect(warmupTokens(jsonl, Date.parse('2026-10-16T10:00:30.000Z'))).toBe(
      2105,
    );
  });

  it('gives haiku the conversation text and tool names, newest kept', () => {
    const excerpt = transcriptExcerpt(jsonl);
    expect(excerpt).toContain('[user] Build the login page.');
    expect(excerpt).toContain('[assistant] (used Edit)');
    expect(excerpt).not.toContain('99999');
    const cut = transcriptExcerpt(jsonl, 30);
    expect(cut.length).toBe(30);
    expect(cut.endsWith('Done with the form.')).toBe(true);
  });
});
