import { describe, expect, test } from 'bun:test';
import {
  breakdownDrill,
  DEFAULT_USAGE_FILTERS,
  todayRange,
  USAGE_FILTER_CODEC,
  usageChipDefs,
  usageFiltersFromSearch,
  usageFiltersSearch,
  usageRange,
} from './filters';

const parse = (search: string) =>
  usageFiltersFromSearch(new URLSearchParams(search));

describe('filters in the URL', () => {
  test('a plain /usage is the defaults', () => {
    expect(parse('')).toEqual(DEFAULT_USAGE_FILTERS);
    expect(usageFiltersSearch(DEFAULT_USAGE_FILTERS)).toBe('');
  });

  test("Overview's /usage?range=today is read", () => {
    expect(parse('range=today').range).toBe('today');
  });

  test('round trip', () => {
    const search =
      '?range=custom&from=2026-10-01&to=2026-10-07&tz=Europe%2FKyiv&projectId=p1&by=slot';
    expect(usageFiltersSearch(parse(search))).toBe(search);
  });

  test('an unreadable value falls back to its default', () => {
    expect(parse('range=year&by=user&from=yesterday')).toEqual(
      DEFAULT_USAGE_FILTERS,
    );
  });

  test('days only count with a custom range', () => {
    expect(parse('range=7d&from=2026-10-01').fromDate).toBe('');
    expect(
      usageFiltersSearch({
        ...DEFAULT_USAGE_FILTERS,
        fromDate: '2026-10-01',
      }),
    ).toBe('');
  });

  test('the old ?projectId= link still works', () => {
    expect(parse('projectId=p1').projectId).toBe('p1');
  });

  test('the codec owns its keys only', () => {
    expect(USAGE_FILTER_CODEC.keys).toEqual([
      'range',
      'from',
      'to',
      'tz',
      'projectId',
      'by',
    ]);
  });
});

describe('ranges', () => {
  test('today runs from local midnight to the end of this hour', () => {
    const now = new Date(2026, 9, 14, 16, 41, 5);
    const range = todayRange(now);
    expect(new Date(range.from).getTime()).toBe(
      new Date(2026, 9, 14, 0, 0, 0).getTime(),
    );
    expect(new Date(range.to).getTime()).toBe(
      new Date(2026, 9, 14, 17, 0, 0).getTime(),
    );
  });

  test('presets, custom and an incomplete custom range', () => {
    const now = new Date('2026-10-14T16:41:05Z');
    expect(
      usageRange({ range: 'today', fromDate: '', toDate: '' }, now),
    ).toEqual(todayRange(now));
    const week = usageRange({ range: '7d', fromDate: '', toDate: '' }, now);
    expect(week?.to).toBe('2026-10-14T17:00:00.000Z');
    expect(
      usageRange({ range: 'custom', fromDate: '2026-10-01', toDate: '' }, now),
    ).toBeNull();
  });
});

describe('breakdownDrill', () => {
  const none = { projectId: '' };

  test('a project row narrows to that project, by slot', () => {
    expect(
      breakdownDrill('project', { key: 'p1', projectId: null }, none),
    ).toEqual({ projectId: 'p1', by: 'slot' });
  });

  test('machine-wide usage has nowhere to go', () => {
    expect(
      breakdownDrill('project', { key: null, projectId: null }, none),
    ).toBeNull();
  });

  test('a slot or issue row narrows to its project, once', () => {
    expect(
      breakdownDrill('slot', { key: 'i1', projectId: 'p2' }, none),
    ).toEqual({ projectId: 'p2' });
    expect(
      breakdownDrill(
        'issue',
        { key: '7', projectId: 'p2' },
        { projectId: 'p2' },
      ),
    ).toBeNull();
  });

  test('never to Fleet: model and runtime rows do not drill', () => {
    expect(
      breakdownDrill('model', { key: 'opus', projectId: 'p1' }, none),
    ).toBeNull();
    expect(
      breakdownDrill('runtime', { key: 'claude', projectId: null }, none),
    ).toBeNull();
  });
});

test('chips: the project and a chosen zone, never the range', () => {
  const labels = usageChipDefs(() => 'Alpha').flatMap(
    (d) =>
      d.label({
        ...DEFAULT_USAGE_FILTERS,
        range: '30d',
        projectId: 'p1',
        tz: 'UTC',
      }) ?? [],
  );
  expect(labels).toEqual(['Project: Alpha', 'Time zone: UTC']);
});
