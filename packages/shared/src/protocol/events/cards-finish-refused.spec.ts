import { describe, expect, it } from 'bun:test';
import {
  cardRunFinishRefusedDataSchema,
  isCardFinishRefusedEventType,
  isCardQuestionEventType,
  isCardRunEventType,
} from './cards';

const data = {
  cardId: 'cm1card0000000000000000001',
  runId: 'cm1run00000000000000000001',
  projectId: 'p1',
  at: '2026-10-16T10:00:00.000Z',
  code: 'not_a_card_session',
};

describe('card_run.finish_refused (#482)', () => {
  it('names the round and the local error, never the summary', () => {
    expect(cardRunFinishRefusedDataSchema.safeParse(data).success).toBe(true);
    expect(
      cardRunFinishRefusedDataSchema.parse({ ...data, summary: 'x' }),
    ).toEqual(data);
  });

  it('refuses a code that is no local error', () => {
    expect(
      cardRunFinishRefusedDataSchema.safeParse({ ...data, code: 'nope' })
        .success,
    ).toBe(false);
  });

  it('is its own event type', () => {
    expect(isCardFinishRefusedEventType('card_run.finish_refused')).toBe(true);
    expect(isCardRunEventType('card_run.finish_refused')).toBe(false);
    expect(isCardQuestionEventType('card_run.finish_refused')).toBe(false);
  });
});
