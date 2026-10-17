import { encodeActionRequestCallback } from './action-request-actions';
import { encodeCallback } from './approval-actions';
import {
  CALLBACK_DATA_MAX,
  callbackCodec,
  LEGACY_CALLBACK_PREFIXES,
} from './callback-data';
import { encodeSessionOptionCallback } from './session-message-actions';
import { PROJECT_CALLBACK } from './telegram-project.service';

const bytes = (data: string) => Buffer.byteLength(data, 'utf8');

// Each test defines codecs under its own prefixes: a prefix is taken once.
describe('callbackCodec', () => {
  it('round-trips every field kind, within 64 bytes at the longest values', () => {
    const withProject = callbackCodec('ta', {
      project: 'project',
      card: 'card',
      n: 'int',
    });
    const withWord = callbackCodec('tz', {
      card: 'card',
      n: 'int',
      action: 'word',
    });
    const longest = {
      project: 'P'.repeat(32),
      card: 'z9'.repeat(4),
      n: 999_999_999_999_999,
      action: 'w'.repeat(16),
    };
    const payloads = [
      [withProject.encode(longest), withProject] as const,
      [withWord.encode(longest), withWord] as const,
    ];
    for (const [data, codec] of payloads) {
      expect(bytes(data)).toBe(codec.maxBytes);
      expect(bytes(data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX);
      expect(codec.matches(data)).toBe(true);
    }
    expect(withProject.decode(payloads[0][0])).toEqual({
      project: longest.project,
      card: longest.card,
      n: longest.n,
    });
    expect(withWord.decode(payloads[1][0])).toEqual({
      card: longest.card,
      n: longest.n,
      action: longest.action,
    });
  });

  it('keeps the project button within 64 bytes at the longest project id', () => {
    const data = PROJECT_CALLBACK.encode({ project: 'p'.repeat(32) });
    expect(bytes(data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX);
    expect(PROJECT_CALLBACK.maxBytes).toBeLessThanOrEqual(CALLBACK_DATA_MAX);
    expect(PROJECT_CALLBACK.decode(data)).toEqual({ project: 'p'.repeat(32) });
  });

  it('refuses at definition a codec that could pass 64 bytes', () => {
    expect(() => callbackCodec('tb', { a: 'project', b: 'project' })).toThrow(
      /64/,
    );
  });

  it('refuses a taken, a legacy or a malformed prefix', () => {
    callbackCodec('tc', { n: 'int' });
    expect(() => callbackCodec('tc', { n: 'int' })).toThrow(/taken/);
    for (const legacy of LEGACY_CALLBACK_PREFIXES) {
      expect(() => callbackCodec(legacy, { n: 'int' })).toThrow(/taken/);
    }
    for (const bad of ['', 'toolong', 'T', 'a:b', '1']) {
      expect(() => callbackCodec(bad, { n: 'int' })).toThrow(/prefix/);
    }
  });

  it('throws on encoding a value of the wrong shape: a bug, not input', () => {
    const codec = callbackCodec('td', { card: 'card', n: 'int' });
    expect(() => codec.encode({ card: 'SHORT', n: 1 })).toThrow(/card/);
    expect(() => codec.encode({ card: 'abcd1234', n: -1 })).toThrow(/int/);
    expect(() => codec.encode({ card: 'abcd1234', n: 1.5 })).toThrow(/int/);
  });

  it('rejects a malformed payload with null, never a throw', () => {
    const codec = callbackCodec('te', { card: 'card', n: 'int' });
    const malformed: (string | undefined)[] = [
      undefined,
      '',
      'te',
      'te:',
      'te:abcd1234',
      'te:abcd1234:1:extra',
      'te:ABCD1234:1',
      'te:abcd1234:01',
      'te:abcd1234:-1',
      'te:abcd1234:1e3',
      'te:abcd1234:9999999999999999',
      'tf:abcd1234:1',
      'a:1:1:abc',
      `te:abcd1234:${'1'.repeat(70)}`,
      'te:abcd1234:1\n',
      'te:abçd1234:1',
    ];
    for (const data of malformed) {
      expect(() => codec.decode(data)).not.toThrow();
      expect(codec.decode(data)).toBeNull();
    }
    expect(codec.decode('te:abcd1234:7')).toEqual({ card: 'abcd1234', n: 7 });
  });

  it('does not match another prefix that starts the same', () => {
    const codec = callbackCodec('tg', { n: 'int' });
    expect(codec.matches('tgx:1')).toBe(false);
    expect(codec.matches('tg:1')).toBe(true);
    expect(codec.matches(undefined)).toBe(false);
  });
});

describe('legacy callback payloads', () => {
  it('stay within 64 bytes at their largest ids', () => {
    const big = 9_223_372_036_854_775_807n;
    const payloads = [
      encodeCallback({
        notificationId: big,
        pr: 999_999_999,
        headSha: 'f'.repeat(40),
        action: 'request_changes',
      }),
      encodeActionRequestCallback({
        action: 'deny',
        notificationId: big,
        actionRequestId: 'r'.repeat(40),
      }),
      encodeSessionOptionCallback({
        notificationId: big,
        questionKey: 'f'.repeat(16),
        index: 99,
      }),
    ];
    for (const data of payloads) {
      expect(bytes(data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX);
    }
  });
});

describe('callbackCodec board kinds (#576)', () => {
  it('round-trips a column, a card number and a page', () => {
    const codec = callbackCodec('tbk', {
      project: 'project',
      column: 'column',
      number: 'number',
      page: 'page',
    });
    const values = {
      project: 'p'.repeat(32),
      column: 'in_progress',
      number: 999_999_999,
      page: 9999,
    } as const;
    const data = codec.encode(values);
    expect(bytes(data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX);
    expect(codec.decode(data)).toEqual(values);
  });

  it('refuses a column, number or page of the wrong shape', () => {
    const codec = callbackCodec('tbj', {
      column: 'column',
      number: 'number',
      page: 'page',
    });
    expect(codec.decode('tbj:todo:12:0')).toEqual({
      column: 'todo',
      number: 12,
      page: 0,
    });
    for (const bad of [
      'tbj:nowhere:12:0',
      'tbj:todo:0:0',
      'tbj:todo:012:0',
      'tbj:todo:1234567890:0',
      'tbj:todo:12:01',
      'tbj:todo:12:10000',
    ]) {
      expect(codec.decode(bad)).toBeNull();
    }
  });
});
