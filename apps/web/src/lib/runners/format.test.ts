import { describe, expect, test } from 'bun:test';
import {
  formatLoad,
  profilesSummary,
  runnerRemedy,
  statusLabel,
} from './format';

describe('formatLoad', () => {
  test('two decimals, slash separated', () => {
    expect(formatLoad([0.4, 1, 0.256])).toBe('0.40 / 1.00 / 0.26');
  });
});

describe('profilesSummary', () => {
  test('lists the first labels and counts the rest', () => {
    const p = (label: string, missing = false) => ({ label, missing });
    expect(profilesSummary([])).toBe('');
    expect(profilesSummary([p('work'), p('home')])).toBe('work, home');
    expect(profilesSummary([p('a'), p('b'), p('c'), p('d')])).toBe('a, b +2');
  });

  test('skips profiles the runner no longer reports', () => {
    expect(
      profilesSummary([{ label: 'old', missing: true }, { label: 'new' }]),
    ).toBe('new');
  });
});

describe('statusLabel', () => {
  test('never paired, paired but never connected, and the rest', () => {
    expect(statusLabel('offline', null)).toBe('not paired');
    expect(statusLabel('offline', '2026-10-01T00:00:00Z', null)).toBe(
      'paired · not running',
    );
    expect(
      statusLabel('offline', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'),
    ).toBe('offline');
    expect(statusLabel('stale', '2026-10-01T00:00:00Z')).toBe('not responding');
    expect(statusLabel('online', '2026-10-01T00:00:00Z')).toBe('online');
  });

  test('callers that do not pass lastSeenAt keep the old reading', () => {
    expect(statusLabel('offline', '2026-10-01T00:00:00Z')).toBe('offline');
  });
});

describe('runnerRemedy', () => {
  const paired = '2026-10-01T00:00:00Z';

  test('nothing to do while online', () => {
    expect(runnerRemedy({ status: 'online', pairedAt: paired })).toBeNull();
  });

  test('an offline runner is told how to start', () => {
    expect(runnerRemedy({ status: 'offline', pairedAt: paired })).toEqual({
      text: 'Start it on its machine:',
      command: 'agentdock-runner run',
    });
  });

  test('a stale runner names the command too', () => {
    expect(runnerRemedy({ status: 'stale', pairedAt: paired })?.command).toBe(
      'agentdock-runner run',
    );
  });

  test('never paired and revoked say what to do instead', () => {
    expect(runnerRemedy({ status: 'offline', pairedAt: null })?.text).toContain(
      'pairing code',
    );
    expect(
      runnerRemedy({ status: 'revoked', pairedAt: paired })?.text,
    ).toContain('add a new runner');
  });
});
