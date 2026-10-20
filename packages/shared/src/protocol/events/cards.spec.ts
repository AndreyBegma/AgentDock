import { describe, expect, it } from 'bun:test';
import {
  CARD_RUN_EVENT_TYPES,
  cardRunEventDataSchemas,
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
