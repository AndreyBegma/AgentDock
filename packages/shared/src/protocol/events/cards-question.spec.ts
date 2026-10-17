import { describe, expect, it } from 'bun:test';
import {
  cardRunQuestionDataSchema,
  isCardPushEventType,
  isCardQuestionEventType,
  isCardRunEventType,
} from './cards';

const data = {
  cardId: 'cm1card0000000000000000001',
  runId: 'cm1run00000000000000000001',
  projectId: 'p1',
  at: '2026-10-16T10:00:00.000Z',
};

describe('card_run.question (#473)', () => {
  it('names the round and never the question', () => {
    expect(cardRunQuestionDataSchema.safeParse(data).success).toBe(true);
    expect(cardRunQuestionDataSchema.parse({ ...data, question: 'x' })).toEqual(
      data,
    );
  });

  it('refuses a round without its card, run or time', () => {
    for (const key of ['cardId', 'runId', 'projectId', 'at'] as const) {
      const { [key]: _, ...bad } = data;
      expect(cardRunQuestionDataSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('is its own event type, apart from the phase and push events', () => {
    expect(isCardQuestionEventType('card_run.question')).toBe(true);
    expect(isCardRunEventType('card_run.question')).toBe(false);
    expect(isCardPushEventType('card_run.question')).toBe(false);
    expect(isCardQuestionEventType('card_run.pushed')).toBe(false);
  });
});
