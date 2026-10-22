import { describe, expect, test } from 'bun:test';
import type { WebhookDeliveryView } from '@nautelle/shared';
import {
  closedGate,
  probeGate,
} from '../../../../components/confirm/gate-probe';
import { redeliverCopy } from '../../../../lib/webhooks/format';

const delivery = {
  id: 'd1',
  eventType: 'run.finished',
} as unknown as WebhookDeliveryView;

describe('Redeliver a webhook delivery (C-166)', () => {
  test('asks, naming the event that is sent again', () => {
    const gate = probeGate(redeliverCopy, delivery);
    expect(gate.dialog.title).toBe('Send run.finished again?');
    expect(gate.dialog.verb).toBe('Redeliver');
  });

  test('the redelivery is queued only after Redeliver, never on Cancel', () => {
    const cancelled = probeGate(redeliverCopy, delivery);
    cancelled.cancel();
    expect(cancelled.confirmed).toEqual([]);
    expect(cancelled.cancelled()).toBe(1);

    const confirmed = probeGate(redeliverCopy, delivery);
    confirmed.confirm();
    expect(confirmed.confirmed).toEqual([delivery]);
  });

  test('nothing pending, nothing drawn', () => {
    expect(closedGate(redeliverCopy).element).toBeNull();
  });
});
