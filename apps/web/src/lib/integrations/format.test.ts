import { describe, expect, test } from 'bun:test';
import type {
  GitHubAppView,
  InboundTriggerView,
  TelegramIntegrationStatus,
  WebhookView,
} from '@nautelle/shared';
import {
  gitHubAppStatus,
  telegramStatus,
  triggersStatus,
  UNAVAILABLE,
  webhooksStatus,
} from './format';

type Registered = Extract<GitHubAppView, { registered: true }>;

const app = (over: Partial<Registered> = {}): Registered => ({
  registered: true,
  encryptionAvailable: true,
  appId: 1,
  slug: 'agentdock-x',
  ownerLogin: 'acme',
  htmlUrl: '',
  installUrl: '',
  hookActive: true,
  publicUrl: 'https://dock.example',
  signatureFailures: 0,
  lastDeliveryAt: null,
  lastSignatureFailureAt: null,
  hookCheckedAt: null,
  hookCheckOk: true,
  createdAt: '',
  updatedAt: '',
  installations: [
    {
      id: 1,
      accountLogin: 'acme',
      accountType: 'Organization',
      suspended: false,
      syncedAt: '',
      repos: [],
    },
  ],
  ...over,
});

describe('gitHubAppStatus', () => {
  test('not registered is neutral, and names the key when it is missing', () => {
    expect(
      gitHubAppStatus({
        registered: false,
        publicUrl: null,
        encryptionAvailable: true,
      }).tone,
    ).toBe('neutral');
    expect(
      gitHubAppStatus({
        registered: false,
        publicUrl: null,
        encryptionAvailable: false,
      }).detail,
    ).toContain('APP_ENCRYPTION_KEY');
  });

  test('the first problem wins, in order of how much it breaks', () => {
    expect(gitHubAppStatus(app({ encryptionAvailable: false })).tone).toBe(
      'danger',
    );
    expect(gitHubAppStatus(app({ hookActive: false })).label).toBe(
      'Webhook inactive',
    );
    expect(gitHubAppStatus(app({ installations: [] })).label).toBe(
      'Not installed',
    );
    expect(gitHubAppStatus(app({ hookCheckOk: false })).label).toBe(
      'Deliveries failing',
    );
    expect(gitHubAppStatus(app()).tone).toBe('ok');
  });
});

describe('telegramStatus', () => {
  const status = (
    over: Partial<TelegramIntegrationStatus>,
  ): TelegramIntegrationStatus => ({
    configured: true,
    botUsername: 'dock_bot',
    encryptionAvailable: true,
    polling: true,
    lastError: null,
    lastPollAt: null,
    linkedUsers: 2,
    ...over,
  });

  test('configured, with errors, and not set up', () => {
    expect(telegramStatus(status({})).detail).toBe(
      '@dock_bot · 2 linked users.',
    );
    expect(telegramStatus(status({ lastError: 'x' })).tone).toBe('warn');
    expect(telegramStatus(status({ configured: false })).label).toBe(
      'Not set up',
    );
  });
});

describe('webhooks and triggers', () => {
  const webhook = (over: Partial<WebhookView>) =>
    ({ enabled: true, circuitState: 'closed', ...over }) as WebhookView;
  const trigger = (over: Partial<InboundTriggerView>) =>
    ({ enabled: true, disabledReason: null, ...over }) as InboundTriggerView;

  test('a paused receiver is a warning; none is neutral, not an error', () => {
    expect(webhooksStatus([]).tone).toBe('neutral');
    expect(webhooksStatus([webhook({ circuitState: 'open' })]).label).toBe(
      '1 receiver failing',
    );
    expect(
      webhooksStatus([webhook({}), webhook({ enabled: false })]).label,
    ).toBe('1 of 2 enabled');
  });

  test('a trigger Nautelle turned off is a warning; one a person turned off is not', () => {
    expect(
      triggersStatus([
        trigger({ enabled: false, disabledReason: 'creator_not_authorized' }),
      ]).tone,
    ).toBe('warn');
    expect(
      triggersStatus([trigger({ enabled: false, disabledReason: 'manual' })])
        .tone,
    ).toBe('neutral');
  });
});

test('a failed card is unknown, never "off"', () => {
  expect(UNAVAILABLE.label).toBe('Status unavailable');
});
