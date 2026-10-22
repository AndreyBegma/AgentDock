import { describe, expect, test } from 'bun:test';
import type { AdminUser } from '@nautelle/shared';
import { closedGate, probeGate } from '../../../components/confirm/gate-probe';
import { type Confirmation, confirmationCopy } from './confirmation';

const user = { id: 'u1', email: 'ann@example.com' } as AdminUser;

describe('Approve a pending user (C-166)', () => {
  test('the title names the role being granted', () => {
    const gate = probeGate<Confirmation>(confirmationCopy, {
      user,
      action: 'approve',
      role: 'admin',
    });
    expect(gate.dialog.title).toBe('Approve ann@example.com as Admin?');
    expect(gate.dialog.verb).toBe('Approve');
    // An admin grant puts the focus on Cancel.
    expect(gate.dialog.tone).toBe('danger');
    expect(
      probeGate<Confirmation>(confirmationCopy, {
        user,
        action: 'approve',
        role: 'viewer',
      }).dialog.title,
    ).toBe('Approve ann@example.com as Viewer?');
  });

  test('the approval runs only after Approve, never on Cancel', () => {
    const pending: Confirmation = { user, action: 'approve', role: 'admin' };
    const cancelled = probeGate(confirmationCopy, pending);
    cancelled.cancel();
    expect(cancelled.confirmed).toEqual([]);
    expect(cancelled.cancelled()).toBe(1);

    const confirmed = probeGate(confirmationCopy, pending);
    confirmed.confirm();
    expect(confirmed.confirmed).toEqual([pending]);
  });

  test('a click that only asks draws nothing until something is pending', () => {
    const gate = closedGate(confirmationCopy);
    expect(gate.element).toBeNull();
    expect(gate.calls()).toBe(0);
  });
});
