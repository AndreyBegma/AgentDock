import { describe, expect, test } from 'bun:test';
import { EMPTY_FILTERS } from '../../../lib/audit/format';
import { activeChips, clearAll } from '../../../lib/filters/url-filters';
import {
  AUDIT_FILTER_CODEC,
  auditChipDefs,
  auditFiltersFromSearch,
  auditFiltersSearch,
  moreFilterCount,
} from './filters';

const parse = (query: string) =>
  auditFiltersFromSearch(new URLSearchParams(query));

describe('audit filters in the URL', () => {
  test('a plain URL is no filter', () => {
    expect(parse('')).toEqual(EMPTY_FILTERS);
    expect(auditFiltersSearch(EMPTY_FILTERS)).toBe('');
  });

  test('reads every filter', () => {
    expect(
      parse(
        'action=runner.revoke&result=error&actor=u1&from=2026-10-01&to=2026-10-14&targetType=runner&targetId=r1&projectId=p1',
      ),
    ).toEqual({
      action: 'runner.revoke',
      result: 'error',
      actorUserId: 'u1',
      fromDate: '2026-10-01',
      toDate: '2026-10-14',
      targetType: 'runner',
      targetId: 'r1',
      projectId: 'p1',
    });
  });

  test('an action group prefix is kept, an unknown action is not', () => {
    expect(parse('action=runner.').action).toBe('runner.');
    expect(parse('action=nope.nothing').action).toBe('');
    expect(parse('action=nope.').action).toBe('');
  });

  test('an unknown result or a malformed day is "not set"', () => {
    expect(parse('result=maybe').result).toBe('');
    expect(parse('from=yesterday&to=2026-13').fromDate).toBe('');
    expect(parse('from=yesterday&to=2026-13').toDate).toBe('');
  });

  test('round-trips', () => {
    const form = {
      ...EMPTY_FILTERS,
      action: 'user.',
      result: 'denied',
      fromDate: '2026-10-01',
    };
    expect(
      AUDIT_FILTER_CODEC.parse(
        new URLSearchParams(AUDIT_FILTER_CODEC.search(form)),
      ),
    ).toEqual(form);
  });

  test('counts the filters under More filters only', () => {
    expect(
      moreFilterCount({
        ...EMPTY_FILTERS,
        action: 'user.',
        fromDate: '2026-10-01',
        projectId: 'p1',
      }),
    ).toBe(2);
  });

  test('chips name the actor and Clear all empties every filter', () => {
    const defs = auditChipDefs((id) => (id === 'u1' ? 'ada@x.dev' : id));
    const chips = activeChips(
      { ...EMPTY_FILTERS, actorUserId: 'u1', result: 'error' },
      defs,
    );
    expect(chips.map((c) => c.label)).toEqual([
      'Result: Failed',
      'Actor: ada@x.dev',
    ]);
    expect(clearAll(defs)).toEqual(EMPTY_FILTERS);
  });
});
