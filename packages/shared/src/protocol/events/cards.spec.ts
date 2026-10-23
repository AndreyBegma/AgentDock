import { describe, expect, it } from 'bun:test';
import {
  CARD_RUN_EVENT_TYPES,
  cardRunEventDataSchemas,
  cardRunQuotaDataSchema,
  isCardQuotaEventType,
  isCardRunEventType,
} from './cards';

const data = {
  cardId: 'cm1card0000000000000000001',
  runId: 'cm1run00000000000000000001',
  projectId: 'p1',
  phase: 'running',
  at: '2026-10-14T10:00:00.000Z',
  tmuxSession: 'nautelle-card-ab12cd34',
  worktree: '/home/me/.wt-app-card-ab12cd34',
};

const schema = cardRunEventDataSchemas['card_run.phase_changed'];

describe('card_run.phase_changed', () => {
  it('accepts every runner phase', () => {
    for (const phase of ['starting', 'running', 'ended', 'failed']) {
      expect(schema.safeParse({ ...data, phase }).success).toBe(true);
    }
  });

  it('refuses a board phase the runner does not own', () => {
    for (const phase of ['waiting', 'finished', 'cancelled', 'queued']) {
      expect(schema.safeParse({ ...data, phase }).success).toBe(false);
    }
  });

  it('carries the exit code of an ended session and the error of a failed one', () => {
    expect(
      schema.safeParse({ ...data, phase: 'ended', exitCode: 0 }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ ...data, phase: 'failed', error: 'no such base' })
        .success,
    ).toBe(true);
    expect(schema.safeParse({ ...data, error: '' }).success).toBe(false);
  });

  it('refuses a session that is not a card session and a relative worktree', () => {
    expect(schema.safeParse({ ...data, tmuxSession: 'cs-i1' }).success).toBe(
      false,
    );
    expect(schema.safeParse({ ...data, worktree: 'wt' }).success).toBe(false);
  });

  it('is the one card run event type', () => {
    expect(CARD_RUN_EVENT_TYPES).toEqual(['card_run.phase_changed']);
    expect(isCardRunEventType('card_run.phase_changed')).toBe(true);
    expect(isCardRunEventType('skill_run.phase_changed')).toBe(false);
  });
});

describe('card_run.quota (#741)', () => {
  const quota = {
    cardId: data.cardId,
    runId: data.runId,
    projectId: data.projectId,
    at: '2026-10-21T10:00:00.000Z',
    limit: 'session' as const,
    resetsAt: '2026-10-21T15:00:00.000Z',
  };

  it('carries the limit and its reset, and is not a resume by default', () => {
    expect(cardRunQuotaDataSchema.parse(quota)).toEqual({
      ...quota,
      resumed: false,
    });
  });

  it('allows a banner with no reset time', () => {
    expect(
      cardRunQuotaDataSchema.safeParse({ ...quota, resetsAt: null }).success,
    ).toBe(true);
  });

  it('refuses an unknown limit kind or a reset that is not a time', () => {
    expect(
      cardRunQuotaDataSchema.safeParse({ ...quota, limit: 'monthly' }).success,
    ).toBe(false);
    expect(
      cardRunQuotaDataSchema.safeParse({ ...quota, resetsAt: 'Mon 9am' })
        .success,
    ).toBe(false);
  });

  it('is its own event type', () => {
    expect(isCardQuotaEventType('card_run.quota')).toBe(true);
    expect(isCardRunEventType('card_run.quota')).toBe(false);
    expect(isCardQuotaEventType('card_run.question')).toBe(false);
  });
});
