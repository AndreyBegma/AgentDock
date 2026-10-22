import { describe, expect, test } from 'bun:test';
import type { BoardCardView } from '@nautelle/shared';
import { closedGate, probeGate } from '../../components/confirm/gate-probe';
import { type CardConfirmation, cardConfirmCopy } from './card-confirm';

const card = { number: 7, label: 'C-7' } as BoardCardView;

describe('Dismiss one Inbox card (C-166)', () => {
  test('asks, naming the card that is deleted', () => {
    const gate = probeGate<CardConfirmation>(cardConfirmCopy, {
      kind: 'dismiss',
      card,
    });
    expect(gate.dialog.title).toBe('Dismiss C-7?');
    expect(gate.dialog.verb).toBe('Dismiss');
    expect(gate.dialog.tone).toBe('danger');
  });

  test('the dismissal runs only after Dismiss, never on Cancel', () => {
    const pending: CardConfirmation = { kind: 'dismiss', card };
    const cancelled = probeGate(cardConfirmCopy, pending);
    cancelled.cancel();
    expect(cancelled.confirmed).toEqual([]);
    expect(cancelled.cancelled()).toBe(1);

    const confirmed = probeGate(cardConfirmCopy, pending);
    confirmed.confirm();
    expect(confirmed.confirmed).toEqual([pending]);
  });

  test('nothing pending, nothing drawn', () => {
    expect(closedGate(cardConfirmCopy).element).toBeNull();
  });
});

describe('the other card confirmations keep their words', () => {
  test('dismiss all, stop and delete', () => {
    expect(cardConfirmCopy({ kind: 'dismiss-all', count: 3 }).title).toBe(
      'Dismiss all 3 suggestions?',
    );
    expect(cardConfirmCopy({ kind: 'stop', card }).verb).toBe('Stop worker');
    expect(cardConfirmCopy({ kind: 'delete', card }).title).toBe('Delete C-7?');
  });
});
