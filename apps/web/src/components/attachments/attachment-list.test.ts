import { describe, expect, test } from 'bun:test';
import type { AttachmentView } from '@nautelle/shared';
import { removeAttachmentCopy } from '../../lib/attachments/format';
import { closedGate, probeGate } from '../confirm/gate-probe';

const file = { id: 'a1', name: 'trace.log' } as AttachmentView;

describe('Remove an attachment (C-166)', () => {
  test('asks, naming the file that goes', () => {
    const gate = probeGate(removeAttachmentCopy, file);
    expect(gate.dialog.title).toBe('Remove trace.log?');
    expect(gate.dialog.verb).toBe('Remove');
    expect(gate.dialog.tone).toBe('danger');
  });

  test('the removal runs only after Remove, never on Cancel', () => {
    const cancelled = probeGate(removeAttachmentCopy, file);
    cancelled.cancel();
    expect(cancelled.confirmed).toEqual([]);
    expect(cancelled.cancelled()).toBe(1);

    const confirmed = probeGate(removeAttachmentCopy, file);
    confirmed.confirm();
    expect(confirmed.confirmed).toEqual([file]);
  });

  test('nothing pending, nothing drawn', () => {
    expect(closedGate(removeAttachmentCopy).element).toBeNull();
  });
});
