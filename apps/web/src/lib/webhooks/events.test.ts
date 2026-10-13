import { describe, expect, test } from 'bun:test';
import {
  WEBHOOK_CIRCUIT_STATES,
  WEBHOOK_EVENT_TYPES,
  WEBHOOKS_ERROR,
} from '@agentdock/shared';
import { ApiError } from '../api';
import { EVENT_DESCRIPTION, triggerUrl } from './events';
import { actionSummary, CIRCUIT_LABEL, describeWebhooksError } from './format';

describe('event descriptions', () => {
  test('every event a webhook can subscribe to says what it means', () => {
    for (const type of WEBHOOK_EVENT_TYPES) {
      expect(EVENT_DESCRIPTION[type].length).toBeGreaterThan(10);
    }
  });
});

describe('triggerUrl', () => {
  test('is absolute, under the web app’s /api rewrite', () => {
    expect(triggerUrl('https://dock.example/', '/hooks/abc')).toBe(
      'https://dock.example/api/hooks/abc',
    );
  });
});

describe('plain words (R5)', () => {
  test('the circuit breaker is said as whether deliveries go out', () => {
    for (const state of WEBHOOK_CIRCUIT_STATES) {
      expect(CIRCUIT_LABEL[state]).not.toMatch(/circuit|half|^open$|^closed$/i);
    }
    expect(CIRCUIT_LABEL.open).toBe('Delivery paused (receiver failing)');
  });

  test('an orchestrator trigger reads as a round, not a command', () => {
    expect(actionSummary({ kind: 'orchestrator', mode: 'next' })).toBe(
      'next orchestrator round',
    );
  });

  test('a missing key says the variable, an example, where it goes and the restart (R4)', () => {
    const text = describeWebhooksError(
      new ApiError(409, WEBHOOKS_ERROR.encryptionKeyMissing as never, 'x'),
    );
    expect(text).toContain('APP_ENCRYPTION_KEY=');
    expect(text).toContain('openssl rand -base64 32');
    expect(text).toContain('restart the API');
  });
});
