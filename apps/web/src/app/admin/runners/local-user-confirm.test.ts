import { describe, expect, test } from 'bun:test';
import { closedGate, probeGate } from '../../../components/confirm/gate-probe';
import {
  type LocalUserChange,
  localUserChangeCopy,
} from '../../../lib/runners/local-settings';

const ann: LocalUserChange = { id: 'u1', label: 'Ann (ann@example.com)' };

describe("Change the runner's local user (C-166)", () => {
  test('asks, naming the user the machine will act as', () => {
    const gate = probeGate(localUserChangeCopy, ann);
    expect(gate.dialog.title).toBe(
      'Act as Ann (ann@example.com) on this machine?',
    );
    expect(gate.dialog.verb).toBe('Change user');
    expect(
      probeGate(localUserChangeCopy, { id: null, label: 'No local user' })
        .dialog.title,
    ).toBe('Remove the local user?');
  });

  test('the change is saved only after confirming, never on Cancel', () => {
    const cancelled = probeGate(localUserChangeCopy, ann);
    cancelled.cancel();
    expect(cancelled.confirmed).toEqual([]);
    expect(cancelled.cancelled()).toBe(1);

    const confirmed = probeGate(localUserChangeCopy, ann);
    confirmed.confirm();
    expect(confirmed.confirmed).toEqual([ann]);
  });

  test('nothing pending, nothing drawn', () => {
    expect(closedGate(localUserChangeCopy).element).toBeNull();
  });
});
