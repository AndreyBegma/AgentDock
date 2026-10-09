import { describe, expect, test } from 'bun:test';
import { TERMINAL_CLOSE_CODES } from '@agentdock/shared';
import { TERMINAL_MAX_DATA_BYTES } from '@agentdock/shared/protocol';
import { ApiError } from '../api';
import {
  clampSize,
  describeCloseCode,
  describeRefusal,
  describeTicketError,
  inputFrames,
  terminalSocketUrl,
} from './format';

describe('terminalSocketUrl', () => {
  test('swaps the live path for /terminal and carries ticket and size', () => {
    const url = new URL(
      terminalSocketUrl('abc', { cols: 100, rows: 30 }, 'ws://h:8180/live?x=1'),
    );
    expect(url.pathname).toBe('/terminal');
    expect(url.searchParams.get('ticket')).toBe('abc');
    expect(url.searchParams.get('cols')).toBe('100');
    expect(url.searchParams.get('rows')).toBe('30');
    expect(url.searchParams.has('x')).toBe(false);
  });
});

describe('clampSize', () => {
  test('keeps the size inside what the API accepts', () => {
    expect(clampSize(1, 1)).toEqual({ cols: 10, rows: 2 });
    expect(clampSize(9999, 9999)).toEqual({ cols: 500, rows: 200 });
    expect(clampSize(80.4, 24.6)).toEqual({ cols: 80, rows: 25 });
  });
});

describe('inputFrames', () => {
  test('small input is one frame of its UTF-8 bytes', () => {
    const frames = inputFrames('ls\r');
    expect(frames).toHaveLength(1);
    expect(new TextDecoder().decode(frames[0])).toBe('ls\r');
  });

  test('empty input sends nothing', () => {
    expect(inputFrames('')).toEqual([]);
  });

  test('a paste is split under the frame cap without breaking a character', () => {
    const text = '€'.repeat(TERMINAL_MAX_DATA_BYTES); // 3 bytes each
    const frames = inputFrames(text);
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) {
      expect(frame.length).toBeLessThanOrEqual(TERMINAL_MAX_DATA_BYTES);
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    expect(frames.map((f) => decoder.decode(f)).join('')).toBe(text);
  });
});

describe('messages', () => {
  test('busy names the holder', () => {
    expect(describeRefusal('busy', { email: 'a@b.c' })).toContain('a@b.c');
    expect(describeRefusal('busy')).toContain('read-write');
  });

  test('every refusal close code has its own sentence', () => {
    const codes = [
      TERMINAL_CLOSE_CODES.invalidTicket,
      TERMINAL_CLOSE_CODES.unauthorized,
      TERMINAL_CLOSE_CODES.forbiddenOrigin,
      TERMINAL_CLOSE_CODES.notFound,
      TERMINAL_CLOSE_CODES.forbidden,
      TERMINAL_CLOSE_CODES.busy,
      TERMINAL_CLOSE_CODES.unsupported,
      TERMINAL_CLOSE_CODES.runnerUnavailable,
    ];
    expect(new Set(codes.map(describeCloseCode)).size).toBe(codes.length);
    expect(describeCloseCode(1006)).toContain('keeps running');
  });

  test('a ticket refused as busy names who holds control', () => {
    const error = new ApiError(409, undefined, 'x', undefined, {
      error: 'busy',
      heldBy: { id: '1', email: 'boss@x.io' },
    });
    expect(describeTicketError(error)).toContain('boss@x.io');
  });

  test('a ticket refused as unsupported or 403 reads plainly', () => {
    expect(
      describeTicketError(
        new ApiError(409, undefined, 'x', undefined, { error: 'unsupported' }),
      ),
    ).toContain('cannot attach');
    expect(
      describeTicketError(new ApiError(403, undefined, 'Forbidden')),
    ).toContain('administrators');
    expect(describeTicketError(new Error('boom'))).toBe(
      'Could not reach the server.',
    );
  });
});
