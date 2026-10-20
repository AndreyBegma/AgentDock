import { describe, expect, test } from 'bun:test';
import { STATUSES } from '@andrewbehma/glass-ui/status-pill';
import {
  ORCHESTRATOR_STATUSES,
  QUEUE_STATES,
  RUN_STATUSES,
  SLOT_STATUSES,
} from '@nautelle/shared';
import { skillRunPhaseSchema } from '@nautelle/shared/protocol';
import {
  ORCHESTRATOR_PILL_STATUS,
  QUEUE_PILL_STATUS,
  RUN_PILL_STATUS,
  SKILL_PILL_STATUS,
  SLOT_PILL_STATUS,
} from './pill';

describe('pill status maps', () => {
  test('every domain status maps onto glass-ui’s scale', () => {
    for (const s of SLOT_STATUSES) {
      expect(STATUSES).toContain(SLOT_PILL_STATUS[s]);
    }
    for (const s of RUN_STATUSES) {
      expect(STATUSES).toContain(RUN_PILL_STATUS[s]);
    }
    for (const s of ORCHESTRATOR_STATUSES) {
      expect(STATUSES).toContain(ORCHESTRATOR_PILL_STATUS[s]);
    }
  });

  test('a slot that waits on a person is not drawn as healthy', () => {
    expect(SLOT_PILL_STATUS.prompt).toBe('blocked');
    expect(SLOT_PILL_STATUS.stale).toBe('error');
    expect(SLOT_PILL_STATUS.quota).toBe('paused');
  });

  test('running and finished are different colours, for runs as for slots', () => {
    expect(RUN_PILL_STATUS.running).not.toBe(RUN_PILL_STATUS.succeeded);
    expect(SLOT_PILL_STATUS.running).not.toBe(SLOT_PILL_STATUS.ended);
  });

  test('a blocked run and a failed one are told apart', () => {
    expect(RUN_PILL_STATUS.blocked).toBe('blocked');
    expect(RUN_PILL_STATUS.failed).toBe('error');
  });

  test('every queue state and skill phase maps onto glass-ui’s scale', () => {
    for (const s of QUEUE_STATES) {
      expect(STATUSES).toContain(QUEUE_PILL_STATUS[s]);
    }
    for (const s of skillRunPhaseSchema.options) {
      expect(STATUSES).toContain(SKILL_PILL_STATUS[s]);
    }
  });

  test('ready and in flight read as different states (#213)', () => {
    expect(QUEUE_PILL_STATUS.ready).toBe('waiting');
    expect(QUEUE_PILL_STATUS.in_flight).toBe('running');
    expect(QUEUE_PILL_STATUS.blocked_person).toBe('blocked');
  });

  test('a skill run that timed out is an error, a cancelled one is not', () => {
    expect(SKILL_PILL_STATUS.timed_out).toBe('error');
    expect(SKILL_PILL_STATUS.cancelled).toBe('idle');
  });
});
