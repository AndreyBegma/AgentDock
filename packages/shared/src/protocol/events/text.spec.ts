import { describe, expect, it } from 'bun:test';
import { TEXT_RESULT_MAX_BYTES } from '../../text/limits';
import {
  isTextEventType,
  TEXT_EVENT_TYPES,
  textEventDataSchemas,
} from './text';

const schema = textEventDataSchemas['text_normalize.finished'];

const data = {
  runId: 'cm1run00000000000000000001',
  projectId: 'p1',
  ok: true,
  at: '2026-10-15T10:00:00.000Z',
  exitCode: 0,
  result: '```agentdock-text\n{"fields": []}\n```',
};

describe('text_normalize.finished', () => {
  it('carries the result text of a successful run', () => {
    const parsed = schema.safeParse(data);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.resultTruncated).toBe(false);
  });

  it('bounds the result to 96 KiB', () => {
    expect(
      schema.safeParse({ ...data, result: 'x'.repeat(TEXT_RESULT_MAX_BYTES) })
        .success,
    ).toBe(true);
    expect(
      schema.safeParse({
        ...data,
        result: 'x'.repeat(TEXT_RESULT_MAX_BYTES + 1),
      }).success,
    ).toBe(false);
  });

  it('needs an error on a failed run', () => {
    expect(
      schema.safeParse({ ...data, ok: false, result: undefined }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...data, ok: false, error: 'timed out after 120 s' })
        .success,
    ).toBe(true);
  });

  it('is the only text event type', () => {
    expect(TEXT_EVENT_TYPES).toEqual(['text_normalize.finished']);
    expect(isTextEventType('text_normalize.finished')).toBe(true);
    expect(isTextEventType('cards_extract.finished')).toBe(false);
  });
});
