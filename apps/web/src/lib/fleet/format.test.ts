import { describe, expect, test } from 'bun:test';
import { ApiError } from '../api';
import {
  describeFleetError,
  formatAge,
  formatAgo,
  formatAheadBehind,
  formatOccupancy,
  formatRound,
  isNotFound,
  issueUrl,
  parseIssueFilter,
  safeHttpsUrl,
  slotsQuery,
} from './format';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

describe('formatAge', () => {
  test('picks the coarsest honest unit', () => {
    expect(formatAge(ago(2), NOW)).toBe('just now');
    expect(formatAge(ago(30), NOW)).toBe('30 s');
    expect(formatAge(ago(5 * 60), NOW)).toBe('5 min');
    expect(formatAge(ago(3 * 3600), NOW)).toBe('3 h');
    expect(formatAge(ago(4 * 86400), NOW)).toBe('4 d');
  });

  test('a clock skewed into the future reads as just now', () => {
    expect(formatAge(ago(-600), NOW)).toBe('just now');
  });

  test('formatAgo never says "just now ago"', () => {
    expect(formatAgo(ago(2), NOW)).toBe('just now');
    expect(formatAgo(ago(5 * 60), NOW)).toBe('5 min ago');
  });
});

describe('formatAheadBehind / formatOccupancy / formatRound', () => {
  test('ahead and behind', () => {
    expect(formatAheadBehind(null, null)).toBe('—');
    expect(formatAheadBehind(2, 1)).toBe('↑2 ↓1');
    expect(formatAheadBehind(3, null)).toBe('↑3 ↓0');
  });

  test('occupancy', () => {
    expect(formatOccupancy(null)).toBe('—');
    expect(formatOccupancy({ occupied: 2, max: 4 })).toBe('2 / 4');
  });

  test('round label', () => {
    expect(formatRound('2026-10-08/1430')).toBe('2026-10-08 14:30');
    expect(formatRound('weird')).toBe('weird');
  });
});

describe('issueUrl / safeHttpsUrl', () => {
  test('derives the issue from a pull request of the same repository', () => {
    expect(issueUrl(11, 'https://github.com/o/r/pull/7')).toBe(
      'https://github.com/o/r/issues/11',
    );
  });

  test('no link without an issue or a pull request', () => {
    expect(issueUrl(null, 'https://github.com/o/r/pull/7')).toBeNull();
    expect(issueUrl(11, null)).toBeNull();
    expect(issueUrl(11, 'https://example.com/not-a-pr')).toBeNull();
  });

  test('only https links are rendered as anchors', () => {
    expect(safeHttpsUrl('https://github.com/o/r/pull/7')).toBe(
      'https://github.com/o/r/pull/7',
    );
    expect(safeHttpsUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpsUrl('http://github.com/o/r')).toBeNull();
    expect(safeHttpsUrl('not a url')).toBeNull();
    expect(safeHttpsUrl(null)).toBeNull();
  });
});

describe('slotsQuery / parseIssueFilter', () => {
  test('builds only the set parameters', () => {
    expect(slotsQuery({})).toBe('');
    expect(slotsQuery({ status: 'ended', issue: 42, cursor: 'c1' })).toBe(
      '?status=ended&issue=42&cursor=c1',
    );
  });

  test('the issue filter takes a positive whole number, with or without #', () => {
    expect(parseIssueFilter('42')).toBe(42);
    expect(parseIssueFilter(' #42 ')).toBe(42);
    expect(parseIssueFilter('')).toBeUndefined();
    expect(parseIssueFilter('0')).toBeUndefined();
    expect(parseIssueFilter('4x')).toBeUndefined();
    expect(parseIssueFilter('-3')).toBeUndefined();
  });
});

describe('errors', () => {
  test('a 404 is "not a member" or "gone"', () => {
    const err = new ApiError(404, undefined, 'Not Found');
    expect(isNotFound(err)).toBe(true);
    expect(describeFleetError(err)).toContain('not a member');
    expect(isNotFound(new Error('x'))).toBe(false);
  });

  test('a missing slot has its own sentence', () => {
    const err = new ApiError(404, 'slot_not_found' as never, 'Slot not found');
    expect(describeFleetError(err)).toBe('That slot no longer exists.');
  });
});
