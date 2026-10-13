import { describe, expect, test } from 'bun:test';
import { RUN_KINDS, type RunUsage } from '@agentdock/shared';
import {
  costLabel,
  EMPTY_RUN_FILTERS,
  hasRunFilters,
  parseRunUpdate,
  prLabel,
  RUN_KIND_LABEL,
  runFiltersDirty,
  runFiltersFromKind,
  runLabel,
  runtimeLabel,
  tokensLabel,
  toRunQuery,
} from './format';

const usage = (patch: Partial<RunUsage> = {}): RunUsage => ({
  input: 1000,
  output: 500,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  reasoning: 0,
  requests: 3,
  costUsd: '1.5',
  unpricedRequests: 0,
  ...patch,
});

describe('run kinds and filters', () => {
  test('every kind has a label without underscores', () => {
    for (const kind of RUN_KINDS) {
      expect(RUN_KIND_LABEL[kind]).not.toContain('_');
    }
  });

  test('a ?kind= link opens the filter; an unknown kind is ignored', () => {
    expect(runFiltersFromKind('skill').kind).toBe('skill');
    expect(runFiltersFromKind('nonsense').kind).toBe('');
    expect(runFiltersFromKind(null)).toEqual(EMPTY_RUN_FILTERS);
  });

  test('the kind filter reaches the query', () => {
    expect(toRunQuery({ ...EMPTY_RUN_FILTERS, kind: 'skill' }).kind).toBe(
      'skill',
    );
  });

  test('no filter set is "nothing yet", any filter set is "no matches"', () => {
    expect(hasRunFilters(EMPTY_RUN_FILTERS)).toBe(false);
    expect(hasRunFilters({ ...EMPTY_RUN_FILTERS, status: 'failed' })).toBe(
      true,
    );
  });

  test('typed but unapplied filters are dirty', () => {
    const form = { ...EMPTY_RUN_FILTERS, status: 'failed' };
    expect(runFiltersDirty(form, {})).toBe(true);
    expect(runFiltersDirty(form, { status: 'failed' })).toBe(false);
  });
});

describe('costLabel', () => {
  test('priced', () => {
    expect(costLabel(usage())).toBe('$1.50');
  });
  test('null cost with requests is unpriced, not zero', () => {
    expect(costLabel(usage({ costUsd: null, unpricedRequests: 3 }))).toBe(
      'unpriced',
    );
  });
  test('partly priced says how many are missing', () => {
    expect(costLabel(usage({ unpricedRequests: 2 }))).toBe(
      '$1.50 + 2 unpriced',
    );
  });
  test('no requests at all is a dash', () => {
    expect(costLabel(usage({ requests: 0, costUsd: null }))).toBe('—');
  });
});

describe('tokensLabel', () => {
  test('sums every bucket', () => {
    expect(tokensLabel(usage({ cacheRead: 500 }))).toBe('2k');
  });
  test('no requests is a dash', () => {
    expect(tokensLabel(usage({ requests: 0 }))).toBe('—');
  });
});

describe('labels', () => {
  test('run label: issue and slot, else title', () => {
    expect(runLabel({ issue: 42, slot: 'i42', title: null })).toBe('#42 · i42');
    expect(runLabel({ issue: null, slot: null, title: 'Nightly' })).toBe(
      'Nightly',
    );
  });
  test('runtime / model', () => {
    expect(runtimeLabel({ runtime: 'claude', model: 'opus' })).toBe(
      'claude / opus',
    );
    expect(runtimeLabel({ runtime: null, model: null })).toBe('—');
  });
  test('PR with and without checks', () => {
    expect(prLabel({ prNumber: null, prChecks: null })).toBe('—');
    expect(prLabel({ prNumber: 9, prChecks: null })).toBe('PR #9');
    expect(prLabel({ prNumber: 9, prChecks: 'green' })).toContain('PR #9 · ');
  });
});

describe('toRunQuery / parseRunUpdate', () => {
  test('keeps a known status only', () => {
    expect(toRunQuery({ ...EMPTY_RUN_FILTERS, status: 'failed' })).toEqual({
      status: 'failed',
    });
    expect(toRunQuery({ ...EMPTY_RUN_FILTERS, status: 'nope' })).toEqual({});
  });
  test('run.updated payload', () => {
    expect(parseRunUpdate({ id: 'r1', status: 'running' })).toEqual({
      id: 'r1',
      status: 'running',
    });
    expect(parseRunUpdate({ id: 'r1', status: 'x' })).toBeNull();
    expect(parseRunUpdate(null)).toBeNull();
  });
});
