import { describe, expect, test } from 'bun:test';
import {
  ORCHESTRATOR_STATUSES,
  RUN_STATUSES,
  SLOT_STATUSES,
} from '@agentdock/shared';
import { STATUSES } from '@andrewbehma/glass-ui/status-pill';
import {
  ORCHESTRATOR_PILL_STATUS,
  RUN_PILL_STATUS,
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
});
