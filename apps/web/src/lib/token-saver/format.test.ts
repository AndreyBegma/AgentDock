import { describe, expect, test } from 'bun:test';
import { ApiError } from '../api';
import {
  describeTokenSaverError,
  filterLabel,
  formatRate,
  formatSavedUsd,
  mcpChoices,
  passThroughShare,
  profilesReportServers,
  runKindLabel,
  sameAllow,
  savedLabel,
  toggleAllow,
} from './format';

describe('savedLabel (D13)', () => {
  test('is "saved ≈ $x" next to the cost', () => {
    expect(savedLabel({ estimateUsd: 0.41, estimateTokens: 90_000 })).toBe(
      'saved ≈ $0.41',
    );
  });

  test('is absent when the round saved nothing', () => {
    expect(savedLabel(null)).toBeNull();
    expect(savedLabel(undefined)).toBeNull();
    expect(savedLabel({ estimateUsd: 0, estimateTokens: 0 })).toBeNull();
  });

  test('a trace is still marked as an estimate', () => {
    expect(formatSavedUsd(0.001)).toBe('≈ <$0.01');
  });
});

describe('formatRate', () => {
  test('whole percents, with 0 and a trace named', () => {
    expect(formatRate(0)).toBe('0%');
    expect(formatRate(0.004)).toBe('<1%');
    expect(formatRate(0.123)).toBe('12%');
    expect(formatRate(1)).toBe('100%');
    expect(formatRate(Number.NaN)).toBe('0%');
  });
});

describe('labels', () => {
  test('a filter id and the uncovered one', () => {
    expect(filterLabel('js/jest')).toBe('js/jest');
    expect(filterLabel('none')).toContain('uncovered');
  });

  test('every run kind has a name', () => {
    expect(runKindLabel('card')).toBe('Card worker');
    expect(runKindLabel('text_normalize')).toBe('Normalize');
    expect(runKindLabel('manual')).toBe('Manual session');
  });

  test('passThroughShare is 0 without commands', () => {
    expect(passThroughShare({ commands: 0, passedThrough: 0 })).toBe(0);
    expect(passThroughShare({ commands: 4, passedThrough: 1 })).toBe(0.25);
  });
});

describe('mcpChoices (D6)', () => {
  test('unions the profiles’ servers, sorted, without agentdock', () => {
    const choices = mcpChoices(
      [
        { mcpServers: ['playwright', 'agentdock'] },
        { mcpServers: ['glitchtip', 'playwright'] },
        {},
      ],
      [],
    );
    expect(choices).toEqual([
      { name: 'glitchtip', reported: true },
      { name: 'playwright', reported: true },
    ]);
  });

  test('keeps an allowed name no profile reports, marked unreported', () => {
    expect(mcpChoices([{ mcpServers: ['a'] }], ['gone', 'a'])).toEqual([
      { name: 'a', reported: true },
      { name: 'gone', reported: false },
    ]);
  });

  test('a viewer (no profiles) still sees the stored list', () => {
    expect(mcpChoices([], ['x'])).toEqual([{ name: 'x', reported: false }]);
  });

  test('knows whether any profile reported', () => {
    expect(profilesReportServers([{}, {}])).toBe(false);
    expect(profilesReportServers([{}, { mcpServers: [] }])).toBe(true);
  });
});

describe('allowlist edits', () => {
  test('toggleAllow adds, removes and keeps the list sorted and unique', () => {
    expect(toggleAllow(['b'], 'a', true)).toEqual(['a', 'b']);
    expect(toggleAllow(['a', 'b'], 'a', true)).toEqual(['a', 'b']);
    expect(toggleAllow(['a', 'b'], 'a', false)).toEqual(['b']);
  });

  test('sameAllow ignores order', () => {
    expect(sameAllow(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameAllow(['a'], ['a', 'b'])).toBe(false);
  });
});

describe('describeTokenSaverError', () => {
  test('names a refused save and a missing project', () => {
    expect(
      describeTokenSaverError(new ApiError(403, undefined, 'x')),
    ).toContain('administrators');
    expect(
      describeTokenSaverError(new ApiError(404, undefined, 'x')),
    ).toContain('not found');
  });
});
