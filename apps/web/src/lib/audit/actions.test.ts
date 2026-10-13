import { describe, expect, test } from 'bun:test';
import { AUDIT_ACTIONS, AUDIT_RESULTS } from '@agentdock/shared';
import {
  ACTION_LABEL,
  actionGroupLabel,
  actionLabel,
  RESULT_LABEL,
} from './actions';
import {
  actionGroups,
  brokenChainCopy,
  filtersPending,
  hasFilters,
} from './format';

describe('action labels (R5)', () => {
  test('every action and every group reads as words', () => {
    for (const action of AUDIT_ACTIONS) {
      expect(ACTION_LABEL[action]).not.toContain('.');
      expect(ACTION_LABEL[action]).not.toContain('_');
    }
    for (const group of actionGroups(AUDIT_ACTIONS)) {
      expect(actionGroupLabel(group)).not.toBe(group);
    }
    for (const result of AUDIT_RESULTS) {
      expect(RESULT_LABEL[result]).not.toBe(result);
    }
  });

  test('a code this build does not know is shown as it came', () => {
    expect(actionLabel('future.thing')).toBe('future.thing');
  });
});

describe('filters', () => {
  test('"nothing matches" is only for a set filter', () => {
    expect(hasFilters({})).toBe(false);
    expect(hasFilters({ action: 'auth.' })).toBe(true);
  });

  test('a changed form is pending until applied', () => {
    const form = {
      fromDate: '',
      toDate: '',
      action: 'auth.',
      actorUserId: '',
      result: '',
      targetType: '',
      targetId: '',
      projectId: '',
    };
    expect(filtersPending(form, {})).toBe(true);
    expect(filtersPending(form, { action: 'auth.' })).toBe(false);
  });
});

test('a broken chain gives the consequence and the next step', () => {
  const text = brokenChainCopy({
    ok: false,
    checked: 10,
    firstBrokenSeq: '7',
    verifiedAt: '2026-10-13T00:00:00.000Z',
  });
  expect(text).toContain('Record 7');
  expect(text).toContain('no longer proves');
  expect(text).toContain('Export the CSV');
});
