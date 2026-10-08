import { describe, expect, it } from 'bun:test';
import {
  base64DecodedBytes,
  messageSchema,
  runnerMessageSchema,
  runnerMessageTypes,
  serverMessageSchema,
  serverMessageTypes,
  TERMINAL_MAX_DATA_B64_LENGTH,
  TERMINAL_MAX_DATA_BYTES,
  terminalClientFrameSchema,
  terminalCloseMessageSchema,
  terminalDataMessageSchema,
  terminalResizeMessageSchema,
} from './index';

const b64 = (bytes: number): string =>
  Buffer.alloc(bytes, 0x61).toString('base64');

const data = (payload: string) => ({
  type: 'terminal.data',
  id: 'term_1',
  b64: payload,
});

describe('terminal.data', () => {
  it('accepts padded base64 up to 64 KiB decoded', () => {
    for (const bytes of [1, 2, 3, 4096, TERMINAL_MAX_DATA_BYTES]) {
      expect(
        terminalDataMessageSchema.safeParse(data(b64(bytes))).success,
      ).toBe(true);
    }
  });

  it('refuses one byte more than 64 KiB, and anything past the length cap', () => {
    const over = b64(TERMINAL_MAX_DATA_BYTES + 1);
    expect(over.length).toBe(TERMINAL_MAX_DATA_B64_LENGTH);
    expect(terminalDataMessageSchema.safeParse(data(over)).success).toBe(false);
    expect(
      terminalDataMessageSchema.safeParse(
        data(b64(TERMINAL_MAX_DATA_BYTES + 3)),
      ).success,
    ).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['unpadded', 'YQ'],
    ['url-safe alphabet', 'a-_a'],
    ['whitespace', 'YWFh\nYWFh'],
    ['padding in the middle', 'YQ==YWFh'],
  ])('refuses %s base64', (_name, payload) => {
    expect(terminalDataMessageSchema.safeParse(data(payload)).success).toBe(
      false,
    );
  });

  it('counts decoded bytes from length and padding', () => {
    for (const bytes of [1, 2, 3, 10, 11, 12]) {
      expect(base64DecodedBytes(b64(bytes))).toBe(bytes);
    }
  });

  it('is strict: a session, a command or any extra field fails', () => {
    for (const extra of [
      { session: 'cs-other' },
      { command: 'rm -rf /' },
      { mode: 'write' },
    ]) {
      expect(
        terminalDataMessageSchema.safeParse({ ...data('YWFh'), ...extra })
          .success,
      ).toBe(false);
    }
  });

  it.each([
    ['empty', ''],
    ['a colon', 'term:1'],
    ['a space', 'term 1'],
    ['too long', 'a'.repeat(129)],
  ])('refuses an id that is %s', (_name, id) => {
    expect(
      terminalDataMessageSchema.safeParse({ ...data('YWFh'), id }).success,
    ).toBe(false);
  });
});

describe('terminal.resize', () => {
  const resize = { type: 'terminal.resize', id: 'term_1', cols: 120, rows: 40 };

  it('accepts the bounds and refuses past them', () => {
    expect(terminalResizeMessageSchema.safeParse(resize).success).toBe(true);
    for (const size of [
      { cols: 10, rows: 2 },
      { cols: 500, rows: 200 },
    ]) {
      expect(
        terminalResizeMessageSchema.safeParse({ ...resize, ...size }).success,
      ).toBe(true);
    }
    for (const size of [
      { cols: 9 },
      { cols: 501 },
      { rows: 1 },
      { rows: 201 },
      { cols: 80.5 },
      { rows: -1 },
    ]) {
      expect(
        terminalResizeMessageSchema.safeParse({ ...resize, ...size }).success,
      ).toBe(false);
    }
  });

  it('is server → runner only', () => {
    expect(serverMessageSchema.safeParse(resize).success).toBe(true);
    expect(runnerMessageSchema.safeParse(resize).success).toBe(false);
  });
});

describe('terminal.close', () => {
  it.each([
    'client',
    'idle',
    'max_duration',
    'session_ended',
    'socket',
  ])('accepts the reason %s', (reason) => {
    expect(
      terminalCloseMessageSchema.safeParse({
        type: 'terminal.close',
        id: 'term_1',
        reason,
      }).success,
    ).toBe(true);
  });

  it('refuses an unknown reason and a missing one', () => {
    for (const close of [
      { type: 'terminal.close', id: 'term_1', reason: 'kill' },
      { type: 'terminal.close', id: 'term_1' },
    ]) {
      expect(terminalCloseMessageSchema.safeParse(close).success).toBe(false);
    }
  });
});

describe('message unions', () => {
  const both = [
    data('YWFh'),
    { type: 'terminal.close', id: 'term_1', reason: 'session_ended' },
  ];

  it('carries data and close in both directions', () => {
    for (const message of both) {
      expect(runnerMessageSchema.safeParse(message).success).toBe(true);
      expect(serverMessageSchema.safeParse(message).success).toBe(true);
      expect(messageSchema.safeParse(message).success).toBe(true);
    }
    expect(runnerMessageTypes).toContain('terminal.data');
    expect(serverMessageTypes).toContain('terminal.data');
    expect(runnerMessageTypes).toContain('terminal.close');
    expect(serverMessageTypes).toContain('terminal.close');
    expect(serverMessageTypes).toContain('terminal.resize');
    expect(runnerMessageTypes).not.toContain('terminal.resize');
  });

  it('has no message that carries a raw session name or a command', () => {
    for (const type of ['terminal.attach', 'terminal.exec', 'terminal.open']) {
      expect(
        messageSchema.safeParse({ type, id: 'term_1', session: 'cs-i42' })
          .success,
      ).toBe(false);
    }
  });
});

describe('browser text frames', () => {
  it('accepts resize and close only', () => {
    expect(
      terminalClientFrameSchema.safeParse({
        type: 'resize',
        cols: 80,
        rows: 24,
      }).success,
    ).toBe(true);
    expect(terminalClientFrameSchema.safeParse({ type: 'close' }).success).toBe(
      true,
    );
    for (const frame of [
      { type: 'data', b64: 'YWFh' },
      { type: 'resize', cols: 80, rows: 24, id: 'term_2' },
      { type: 'close', reason: 'idle' },
      { type: 'resize', cols: 1000, rows: 24 },
      { type: 'mode', mode: 'write' },
    ]) {
      expect(terminalClientFrameSchema.safeParse(frame).success).toBe(false);
    }
  });
});
