import { describe, expect, test } from 'bun:test';
import { parseSse } from './sse';

describe('parseSse', () => {
  test('returns the complete events and keeps the unfinished tail', () => {
    const { events, rest } = parseSse(
      'data: {"type":"delta","text":"Hel"}\n\ndata: {"type":"delta","text":"lo"}\n\ndata: {"type":"del',
    );
    expect(events).toEqual([
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo' },
    ]);
    expect(rest).toBe('data: {"type":"del');
  });

  test('joins a chunk split in the middle of an event', () => {
    const first = parseSse('data: {"type":"delta",');
    expect(first.events).toEqual([]);
    const second = parseSse(`${first.rest}"text":"x"}\n\n`);
    expect(second.events).toEqual([{ type: 'delta', text: 'x' }]);
    expect(second.rest).toBe('');
  });

  test('reads CRLF separators and skips malformed or empty blocks', () => {
    const { events } = parseSse(
      'data: {"type":"delta","text":"a"}\r\n\r\n: ping\n\ndata: nope\n\ndata: {"type":"title","title":"T"}\n\n',
    );
    expect(events).toEqual([
      { type: 'delta', text: 'a' },
      { type: 'title', title: 'T' },
    ]);
  });
});
