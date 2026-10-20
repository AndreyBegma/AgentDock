import { describe, expect, test } from 'bun:test';
import type { LlmProviderView } from '@nautelle/shared';
import {
  capPercent,
  capTone,
  maskedKey,
  monthName,
  parseCap,
  providerStatus,
  resetDay,
} from './format';

const provider = (over: Partial<LlmProviderView> = {}): LlmProviderView => ({
  provider: 'anthropic',
  label: 'Anthropic',
  key: { configured: true, suffix: '4f2a', updatedAt: '2026-10-01T00:00:00Z' },
  capUsd: '200.00',
  enabled: true,
  capReached: false,
  models: [{ id: 'claude-opus-5-5', priced: true }],
  suggestedModels: [],
  spendUsd: '62.10',
  requests: 10,
  inputTokens: 100,
  outputTokens: 10,
  ...over,
});

describe('the cap state', () => {
  test('is ok below 80%, warn from 80%, danger once reached', () => {
    expect(capTone(provider())).toBe('ok');
    expect(capTone(provider({ spendUsd: '160.00' }))).toBe('warn');
    expect(capTone(provider({ spendUsd: '200.00', capReached: true }))).toBe(
      'danger',
    );
    expect(capTone(provider({ enabled: false, capUsd: '0.00' }))).toBe(
      'neutral',
    );
  });

  test('shows spend as a share of the cap, capped at 100', () => {
    expect(capPercent(provider({ spendUsd: '88.40', capUsd: '100.00' }))).toBe(
      88,
    );
    expect(capPercent(provider({ spendUsd: '300.00' }))).toBe(100);
    expect(capPercent(provider({ capUsd: '0.00', enabled: false }))).toBe(0);
  });

  test('names the provider state the table shows', () => {
    expect(providerStatus(provider()).label).toBe('Connected');
    expect(providerStatus(provider({ spendUsd: '176.00' })).label).toBe(
      '88% of cap',
    );
    expect(providerStatus(provider({ capReached: true })).label).toBe(
      'Cap reached',
    );
    expect(
      providerStatus(
        provider({ key: { configured: false, suffix: null, updatedAt: null } }),
      ).label,
    ).toBe('No key');
    expect(providerStatus(provider({ enabled: false })).label).toBe('Disabled');
    expect(providerStatus(provider({ models: [] })).label).toBe('No models');
  });
});

describe('formatting', () => {
  test('masks a key to its suffix', () => {
    expect(maskedKey('4f2a')).toBe('…4f2a');
    expect(maskedKey(null)).toBe('Set');
  });

  test('names the reset day and the month in UTC', () => {
    expect(resetDay('2026-11-01T00:00:00.000Z')).toBe('1 Nov');
    expect(monthName('2026-10-01T00:00:00.000Z')).toBe('October');
  });

  test('parses a cap of dollars with at most two decimals', () => {
    expect(parseCap('200')).toBe(200);
    expect(parseCap('$12.50')).toBe(12.5);
    expect(parseCap('0')).toBe(0);
    expect(parseCap('1.234')).toBeNull();
    expect(parseCap('-1')).toBeNull();
    expect(parseCap('ten')).toBeNull();
  });
});
