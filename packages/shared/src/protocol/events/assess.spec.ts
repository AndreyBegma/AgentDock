import { describe, expect, it } from 'bun:test';
import { CARD_ASSESS_RESULT_MAX_BYTES } from '../../assess/limits';
import {
  ASSESS_EVENT_TYPES,
  assessEventDataSchemas,
  isAssessEventType,
} from './assess';

const schema = assessEventDataSchemas['card_assess.finished'];

const data = {
  runId: 'cm1run00000000000000000001',
  projectId: 'p1',
  ok: true,
  at: '2026-10-15T10:00:00.000Z',
  exitCode: 0,
  result:
    '{"work":{"model":"sonnet","reason":"Clear."},"design":{"model":"opus","reason":"Open."}}',
};

describe('card_assess.finished', () => {
  it('carries the result text of a successful run', () => {
    const parsed = schema.safeParse(data);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.resultTruncated).toBe(false);
  });

  it('bounds the result to 16 KiB', () => {
    expect(
      schema.safeParse({
        ...data,
        result: 'x'.repeat(CARD_ASSESS_RESULT_MAX_BYTES),
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        ...data,
        result: 'x'.repeat(CARD_ASSESS_RESULT_MAX_BYTES + 1),
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

  it('is the only assessment event type', () => {
    expect(ASSESS_EVENT_TYPES).toEqual(['card_assess.finished']);
    expect(isAssessEventType('card_assess.finished')).toBe(true);
    expect(isAssessEventType('text_normalize.finished')).toBe(false);
  });
});
