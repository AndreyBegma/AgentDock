import { describe, expect, test } from 'bun:test';
import type { CardEscalationView } from '@nautelle/shared';
import { escalationAsk, escalationTitle, waitsForOpus } from './escalation';

const escalation: CardEscalationView = {
  reason: 'misclassified',
  note: 'The card needs a migration.',
  at: '2026-10-21T12:00:00.000Z',
};

describe('card escalation (#750 D9, D10)', () => {
  test('names the reason', () => {
    expect(escalationTitle(escalation)).toBe(
      'Escalated to Opus · misclassified',
    );
    expect(escalationAsk({ ...escalation, reason: 'gave_up' })).toBe(
      'The worker asks for Opus: gave up',
    );
  });

  test("waits with Run on Opus only over a person's non-Opus override", () => {
    expect(waitsForOpus({ model: 'sonnet', escalation })).toBe(true);
    expect(waitsForOpus({ model: 'claude-sonnet-5-5', escalation })).toBe(true);
    // Relaunched by the API (no override), or already on Opus.
    expect(waitsForOpus({ model: null, escalation })).toBe(false);
    expect(waitsForOpus({ model: 'opus', escalation })).toBe(false);
    expect(waitsForOpus({ model: 'claude-opus-5-5', escalation })).toBe(false);
    // No escalation, or a view from before #750.
    expect(waitsForOpus({ model: 'sonnet', escalation: null })).toBe(false);
    expect(waitsForOpus({ model: 'sonnet' })).toBe(false);
  });
});
