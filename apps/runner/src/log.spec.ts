import { describe, expect, it } from 'bun:test';
import { createLogger, errorMessage, parseLogLevel, REDACTED } from './log';

const capture = (level: 'debug' | 'info' = 'debug') => {
  const lines: string[] = [];
  const log = createLogger({ level, write: (l) => lines.push(l) });
  return { log, lines };
};

describe('logger', () => {
  it('writes one JSON object per line', () => {
    const { log, lines } = capture();
    log.info('hello', { a: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0])).toMatchObject({
      level: 'info',
      msg: 'hello',
      a: 1,
    });
  });

  it('drops lines below the level', () => {
    const { log, lines } = capture('info');
    log.debug('quiet');
    log.warn('loud');
    expect(lines.map((l) => JSON.parse(l).msg)).toEqual(['loud']);
  });

  it('redacts a registered secret wherever it appears, and token-named keys', () => {
    const { log, lines } = capture();
    log.addSecret('s3cr3t-value');
    log.error('failed with s3cr3t-value inside', {
      nested: { url: 'x?k=s3cr3t-value' },
      token: 'anything',
      Authorization: 'Bearer abc',
    });
    expect(lines[0]).not.toContain('s3cr3t-value');
    expect(lines[0]).not.toContain('abc');
    expect(lines[0].split(REDACTED).length - 1).toBe(4);
  });

  it('reads AGENTDOCK_LOG, defaulting to info', () => {
    expect(parseLogLevel({ AGENTDOCK_LOG: 'DEBUG' })).toBe('debug');
    expect(parseLogLevel({ AGENTDOCK_LOG: 'nonsense' })).toBe('info');
    expect(parseLogLevel({})).toBe('info');
  });

  it('keeps only the first line of an error message', () => {
    const error = new Error('boom\n    at secret/path.ts:1');
    expect(errorMessage(error)).toBe('boom');
  });
});
