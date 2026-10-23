import { describe, expect, test } from 'bun:test';
import type { ScheduleView } from '@nautelle/shared';
import {
  closedGate,
  probeGate,
} from '../../../../../components/confirm/gate-probe';
import { runNowCopy } from '../../../../../lib/schedules/format';

const schedule = {
  id: 's1',
  name: 'Nightly review',
  target: { kind: 'skill', skill: '/cs-review', args: '' },
} as unknown as ScheduleView;

describe('Run a schedule now (C-166)', () => {
  test('asks, naming the schedule and what starts', () => {
    const gate = probeGate(runNowCopy, schedule);
    expect(gate.dialog.title).toBe('Run Nightly review now?');
    expect(gate.dialog.consequence).toContain('/cs-review');
    expect(gate.dialog.verb).toBe('Run now');
  });

  test('the run starts only after Run now, never on Cancel', () => {
    const cancelled = probeGate(runNowCopy, schedule);
    cancelled.cancel();
    expect(cancelled.confirmed).toEqual([]);
    expect(cancelled.cancelled()).toBe(1);

    const confirmed = probeGate(runNowCopy, schedule);
    confirmed.confirm();
    expect(confirmed.confirmed).toEqual([schedule]);
  });

  test('nothing pending, nothing drawn', () => {
    expect(closedGate(runNowCopy).element).toBeNull();
  });
});
