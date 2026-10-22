import { describe, expect, test } from 'bun:test';
import { closedGate, probeGate } from '../../components/confirm/gate-probe';
import { sharePlanCopy } from './header';

const plan = { title: 'Billing rewrite' };

describe('Share a plan with the project (C-166)', () => {
  test('asks, naming the plan and who will read it', () => {
    const gate = probeGate(sharePlanCopy, plan);
    expect(gate.dialog.title).toBe('Share Billing rewrite with the project?');
    expect(gate.dialog.consequence).toContain('Every member of the project');
    expect(gate.dialog.verb).toBe('Share');
  });

  test('the plan is shared only after Share, never on Cancel', () => {
    const cancelled = probeGate(sharePlanCopy, plan);
    cancelled.cancel();
    expect(cancelled.confirmed).toEqual([]);
    expect(cancelled.cancelled()).toBe(1);

    const confirmed = probeGate(sharePlanCopy, plan);
    confirmed.confirm();
    expect(confirmed.confirmed).toEqual([plan]);
  });

  test('nothing pending, nothing drawn', () => {
    expect(closedGate(sharePlanCopy).element).toBeNull();
  });
});
