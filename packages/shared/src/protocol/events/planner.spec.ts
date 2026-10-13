import { describe, expect, it } from 'bun:test';
import {
  isPlanTurnEventType,
  PLAN_TURN_EVENT_TYPES,
  PLAN_TURN_RESULT_MAX_BYTES,
  planTurnFinishedDataSchema,
  planTurnPhaseChangedDataSchema,
} from '../index';

const ref = {
  planId: 'cmplan0001',
  turnId: 'cmturn0001',
  runId: 'cmrun0001',
  projectId: 'prj_1',
};
const at = '2026-11-07T10:00:00.000Z';

describe('plan turn events', () => {
  it('are the two types', () => {
    expect(PLAN_TURN_EVENT_TYPES).toEqual([
      'plan_turn.phase_changed',
      'plan_turn.finished',
    ]);
    expect(isPlanTurnEventType('plan_turn.finished')).toBe(true);
    expect(isPlanTurnEventType('skill_run.finished')).toBe(false);
  });

  it('phase_changed carries every phase', () => {
    for (const phase of ['queued', 'running', 'succeeded', 'failed']) {
      expect(
        planTurnPhaseChangedDataSchema.safeParse({ ...ref, phase, at }).success,
      ).toBe(true);
    }
    expect(
      planTurnPhaseChangedDataSchema.safeParse({ ...ref, phase: 'x', at })
        .success,
    ).toBe(false);
  });

  it('finished carries the result text, the session id and the exit code', () => {
    const finished = {
      ...ref,
      phase: 'succeeded',
      at,
      sessionId: '1e2d3c4b-5a69-4788-9a6b-5c4d3e2f1a0b',
      exitCode: 0,
      resultText: '```agentdock-plan\n{}\n```',
      resultTruncated: false,
    };
    expect(planTurnFinishedDataSchema.safeParse(finished).success).toBe(true);
    expect(
      planTurnFinishedDataSchema.safeParse({ ...finished, phase: 'running' })
        .success,
    ).toBe(false);
    expect(
      planTurnFinishedDataSchema.safeParse({
        ...finished,
        resultText: 'a'.repeat(PLAN_TURN_RESULT_MAX_BYTES + 1),
      }).success,
    ).toBe(false);
  });

  it('a failed turn may have no result', () => {
    expect(
      planTurnFinishedDataSchema.safeParse({
        ...ref,
        phase: 'failed',
        at,
        resultTruncated: false,
        error: 'timeout',
      }).success,
    ).toBe(true);
  });
});
