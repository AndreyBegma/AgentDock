import { describe, expect, it } from 'bun:test';
import {
  cardRunPushedDataSchema,
  isCardPushEventType,
  isCardRunEventType,
} from './cards';

const data = {
  cardId: 'cm1card0000000000000000001',
  runId: 'cm1run00000000000000000001',
  projectId: 'p1',
  at: '2026-10-16T10:00:00.000Z',
  branch: 'card/c12-add-login',
  headSha: 'b'.repeat(40),
};

const pr = {
  prNumber: 42,
  prUrl: 'https://github.com/o/r/pull/42',
  prState: 'draft',
};

describe('card_run.pushed (#359 D1)', () => {
  it('reports a push, with the draft PR once one is open', () => {
    expect(cardRunPushedDataSchema.safeParse(data).success).toBe(true);
    expect(cardRunPushedDataSchema.safeParse({ ...data, ...pr }).success).toBe(
      true,
    );
  });

  it('keeps the PR number, URL and state together', () => {
    for (const bad of [
      { ...data, prNumber: 42 },
      { ...data, prUrl: pr.prUrl },
      { ...data, prState: 'draft' },
    ]) {
      expect(cardRunPushedDataSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('refuses a short head, a merged state or a non-https URL', () => {
    for (const bad of [
      { ...data, headSha: 'abc' },
      { ...data, ...pr, prState: 'merged' },
      { ...data, ...pr, prUrl: 'http://github.com/o/r/pull/42' },
    ]) {
      expect(cardRunPushedDataSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('counts the commits ahead of the base (#837), optional for an older runner', () => {
    expect(
      cardRunPushedDataSchema.safeParse({ ...data, ahead: 3 }).data?.ahead,
    ).toBe(3);
    expect(cardRunPushedDataSchema.safeParse(data).data?.ahead).toBeUndefined();
    for (const ahead of [-1, 1.5]) {
      expect(
        cardRunPushedDataSchema.safeParse({ ...data, ahead }).success,
      ).toBe(false);
    }
  });

  it('is its own event type, apart from the phase events the sink handles', () => {
    expect(isCardPushEventType('card_run.pushed')).toBe(true);
    expect(isCardRunEventType('card_run.pushed')).toBe(false);
    expect(isCardPushEventType('card_run.phase_changed')).toBe(false);
  });
});
