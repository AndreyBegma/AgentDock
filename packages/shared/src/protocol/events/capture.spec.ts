import { describe, expect, it } from 'bun:test';
import { CAPTURE_RESULT_MAX_BYTES } from '../../board/capture-limits';
import {
  CAPTURE_EVENT_TYPES,
  captureEventDataSchemas,
  isCaptureEventType,
} from './capture';

const schema = captureEventDataSchemas['cards_extract.finished'];

const data = {
  runId: 'cm1run00000000000000000001',
  projectId: 'p1',
  ok: true,
  at: '2026-10-15T10:00:00.000Z',
  exitCode: 0,
  result: '```agentdock-cards\n{"cards": []}\n```',
};

describe('cards_extract.finished', () => {
  it('carries the result text of a successful extraction', () => {
    const parsed = schema.safeParse(data);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.resultTruncated).toBe(false);
  });

  it('bounds the result to 32 KiB', () => {
    expect(
      schema.safeParse({
        ...data,
        result: 'x'.repeat(CAPTURE_RESULT_MAX_BYTES),
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        ...data,
        result: 'x'.repeat(CAPTURE_RESULT_MAX_BYTES + 1),
      }).success,
    ).toBe(false);
  });

  it('needs an error on a failed extraction', () => {
    expect(
      schema.safeParse({ ...data, ok: false, result: undefined }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...data, ok: false, error: 'timed out after 180 s' })
        .success,
    ).toBe(true);
    expect(schema.safeParse({ ...data, ok: false, error: '' }).success).toBe(
      false,
    );
  });

  it('is the one capture event type', () => {
    expect(CAPTURE_EVENT_TYPES).toEqual(['cards_extract.finished']);
    expect(isCaptureEventType('cards_extract.finished')).toBe(true);
    expect(isCaptureEventType('card_run.phase_changed')).toBe(false);
  });
});
