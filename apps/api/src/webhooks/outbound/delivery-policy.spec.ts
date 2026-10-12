import {
  WEBHOOK_CIRCUIT_THRESHOLD,
  WEBHOOK_MAX_ATTEMPTS,
} from '@agentdock/shared';
import {
  type Circuit,
  circuitAfterAttempt,
  deliveryAfterAttempt,
} from './delivery-policy';

const NOW = new Date('2026-10-10T12:00:00Z');
const MID = () => 0.5;
/** The retry delay after `attempts` failed attempts, in ms. */
const delay = (attempts: number, random: () => number = MID) =>
  deliveryAfterAttempt(false, attempts, NOW, random).nextAttemptAt.getTime() -
  NOW.getTime();

const CLOSED: Circuit = {
  circuitState: 'closed',
  circuitOpenedAt: null,
  consecutiveFailures: 0,
};
const FAIL = { succeeded: false, counts: true };

describe('deliveryAfterAttempt (spec 26 D12)', () => {
  it('marks a 2xx succeeded', () => {
    expect(deliveryAfterAttempt(true, 3, NOW).status).toBe('succeeded');
  });

  it('retries at 30 s, 60 s, 120 s … without jitter at the midpoint', () => {
    expect([1, 2, 3, 7].map((attempts) => delay(attempts))).toEqual([
      30_000, 60_000, 120_000, 1_920_000,
    ]);
  });

  it('keeps the jitter within ±20 %', () => {
    expect(delay(1, () => 0)).toBe(24_000);
    expect(delay(1, () => 0.999_999)).toBeLessThanOrEqual(36_000);
  });

  it('fails the delivery on the 8th failed attempt', () => {
    expect(
      deliveryAfterAttempt(false, WEBHOOK_MAX_ATTEMPTS - 1, NOW).status,
    ).toBe('pending');
    expect(deliveryAfterAttempt(false, WEBHOOK_MAX_ATTEMPTS, NOW).status).toBe(
      'failed',
    );
  });
});

describe('circuitAfterAttempt (spec 26 D14)', () => {
  it('opens on the 10th consecutive failure', () => {
    let circuit = CLOSED;
    for (let i = 1; i < WEBHOOK_CIRCUIT_THRESHOLD; i += 1) {
      circuit = circuitAfterAttempt(circuit, FAIL, NOW);
      expect(circuit.circuitState).toBe('closed');
    }
    circuit = circuitAfterAttempt(circuit, FAIL, NOW);
    expect(circuit).toEqual({
      circuitState: 'open',
      circuitOpenedAt: NOW,
      consecutiveFailures: WEBHOOK_CIRCUIT_THRESHOLD,
    });
  });

  it('resets the count on a success', () => {
    const failing = { ...CLOSED, consecutiveFailures: 9 };
    expect(
      circuitAfterAttempt(failing, { succeeded: true, counts: true }, NOW),
    ).toEqual(CLOSED);
  });

  it('closes a half-open circuit on success and reopens it on failure', () => {
    const probing: Circuit = {
      circuitState: 'half_open',
      circuitOpenedAt: new Date(NOW.getTime() - 1000),
      consecutiveFailures: 10,
    };
    expect(
      circuitAfterAttempt(probing, { succeeded: true, counts: true }, NOW)
        .circuitState,
    ).toBe('closed');
    expect(circuitAfterAttempt(probing, FAIL, NOW)).toEqual({
      circuitState: 'open',
      circuitOpenedAt: NOW,
      consecutiveFailures: 11,
    });
  });

  it('keeps an open circuit open without moving its clock', () => {
    const opened = new Date(NOW.getTime() - 60_000);
    const open: Circuit = {
      circuitState: 'open',
      circuitOpenedAt: opened,
      consecutiveFailures: 10,
    };
    expect(circuitAfterAttempt(open, FAIL, NOW).circuitOpenedAt).toBe(opened);
  });

  it('does not count a failure that is not the receiver’s', () => {
    const failing = { ...CLOSED, consecutiveFailures: 9 };
    expect(
      circuitAfterAttempt(failing, { succeeded: false, counts: false }, NOW),
    ).toEqual(failing);
  });
});
