import { type PlanStatusTurn, planAttention } from './plan-status';

const failed: PlanStatusTurn = {
  id: 'turn-1',
  phase: 'failed',
  error: 'plan.turn failed on the runner: unknown_command',
  createdAt: new Date('2026-10-14T10:00:00Z'),
  finishedAt: new Date('2026-10-14T10:01:00Z'),
};

describe('planAttention', () => {
  it('is failed for a drafting plan whose newest turn failed', () => {
    expect(planAttention('drafting', failed)).toEqual({
      kind: 'failed',
      reason: 'plan.turn failed on the runner: unknown_command',
      turnId: 'turn-1',
      at: '2026-10-14T10:01:00.000Z',
    });
  });

  it('is failed for a clarifying plan too', () => {
    expect(planAttention('clarifying', failed)?.kind).toBe('failed');
  });

  it('asks for attention when a turn fails on a plan under review', () => {
    expect(planAttention('reviewing', failed)?.kind).toBe('attention');
  });

  it('is null when no turn ran yet', () => {
    expect(planAttention('drafting', null)).toBeNull();
  });

  it.each([
    'queued',
    'running',
    'succeeded',
    'cancelled',
  ] as const)('is null when the newest turn is %s (a retry replaced the failure)', (phase) => {
    expect(planAttention('drafting', { ...failed, phase })).toBeNull();
  });

  it.each([
    'sending',
    'sent',
    'archived',
  ] as const)('is null for a %s plan, which takes no more turns', (status) => {
    expect(planAttention(status, failed)).toBeNull();
  });

  it('says so when the runner gave no reason, and falls back to createdAt', () => {
    expect(
      planAttention('drafting', { ...failed, error: null, finishedAt: null }),
    ).toMatchObject({
      reason: 'The runner gave no reason.',
      at: '2026-10-14T10:00:00.000Z',
    });
  });
});
