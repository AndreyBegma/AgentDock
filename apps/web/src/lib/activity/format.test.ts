import { describe, expect, test } from 'bun:test';
import { type ActivityItem, STEWARD_ACTIVITY_TYPES } from '@agentdock/shared';
import {
  ACTIVITY_FILTER_CODEC,
  activityChipDefs,
  activityHref,
  actorName,
  EMPTY_ACTIVITY_FILTERS,
  formFromSearch,
  formSearch,
  groupRows,
  hasActivityFilters,
  itemMeta,
  itemTitle,
  LIVE_PROJECT_BUDGET,
  matchesQuery,
  mergeItems,
  moreFilterCount,
  PROJECT_ACTIVITY_FILTER_CODEC,
  parseLiveItem,
  planLive,
  prLink,
  queryString,
  STEWARD_TYPE_OPTIONS,
  safeLink,
  TYPE_OPTIONS,
  toActivityQuery,
  toTimelineItem,
  typeLabel,
} from './format';

const item = (patch: Partial<ActivityItem> = {}): ActivityItem => ({
  id: '1',
  ts: '2026-10-08T10:00:00.000Z',
  projectId: 'p1',
  category: 'fleet',
  type: 'pr.opened',
  severity: 'info',
  title: 'PR opened',
  actorType: 'orchestrator',
  actorId: null,
  actorEmail: null,
  slot: null,
  issue: null,
  prNumber: null,
  link: null,
  data: {},
  ...patch,
});

describe('toActivityQuery / queryString', () => {
  test('drops empty fields and an unknown category', () => {
    const query = toActivityQuery({
      projectId: 'p1',
      category: 'bogus',
      type: ' pr.opened ',
      actor: '',
      slot: '',
      fromDate: '',
      toDate: '',
    });
    expect(query).toEqual({ projectId: 'p1', type: 'pr.opened' });
    expect(queryString(query, { limit: 50 })).toBe(
      '?projectId=p1&type=pr.opened&limit=50',
    );
  });

  test('the end date is exclusive: the next local midnight', () => {
    const query = toActivityQuery({
      projectId: '',
      category: 'audit',
      type: '',
      actor: '',
      slot: '',
      fromDate: '2026-10-01',
      toDate: '2026-10-01',
    });
    expect(query.category).toBe('audit');
    expect(Date.parse(query.to ?? '') - Date.parse(query.from ?? '')).toBe(
      24 * 3_600_000,
    );
  });

  test('an empty query is an empty string', () => {
    expect(queryString({})).toBe('');
  });
});

describe('matchesQuery', () => {
  test('applies each filter', () => {
    expect(matchesQuery(item(), {})).toBe(true);
    expect(matchesQuery(item(), { projectId: 'p2' })).toBe(false);
    expect(matchesQuery(item(), { category: 'audit' })).toBe(false);
    expect(matchesQuery(item(), { type: 'pr.opened' })).toBe(true);
    expect(matchesQuery(item({ slot: 'i1' }), { slot: 'i2' })).toBe(false);
    expect(matchesQuery(item({ actorId: 'u1' }), { actor: 'u1' })).toBe(true);
  });

  test('from is inclusive, to is exclusive', () => {
    const at = '2026-10-08T10:00:00.000Z';
    expect(matchesQuery(item(), { from: at })).toBe(true);
    expect(matchesQuery(item(), { to: at })).toBe(false);
  });
});

describe('mergeItems', () => {
  test('dedupes by id and keeps newest first', () => {
    const a = item({ id: '2', ts: '2026-10-08T10:00:00.000Z' });
    const b = item({ id: '3', ts: '2026-10-08T11:00:00.000Z' });
    const merged = mergeItems([a], [b, a]);
    expect(merged.map((i) => i.id)).toEqual(['3', '2']);
  });

  test('same timestamp: the higher id first, compared as numbers', () => {
    const low = item({ id: '9' });
    const high = item({ id: '10' });
    expect(mergeItems([low], [high]).map((i) => i.id)).toEqual(['10', '9']);
  });

  test('nothing new returns the same array', () => {
    const list = [item()];
    expect(mergeItems(list, [item()])).toBe(list);
  });
});

describe('parseLiveItem', () => {
  test('accepts an item, rejects junk', () => {
    expect(parseLiveItem(item())?.id).toBe('1');
    expect(parseLiveItem(null)).toBeNull();
    expect(parseLiveItem({ id: 'x' })).toBeNull();
    expect(parseLiveItem({ ...item(), id: 'abc' })).toBeNull();
  });
});

describe('planLive', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);

  test('a fixed or filtered project follows only its own topic', () => {
    expect(
      planLive({ projectId: 'p9', projectIds: ids(40), isAdmin: true }),
    ).toEqual({ topics: ['project:p9'], poll: false });
  });

  test('within the budget: one topic per project, admin adds the admin topic', () => {
    const plan = planLive({
      projectIds: ids(LIVE_PROJECT_BUDGET),
      isAdmin: true,
    });
    expect(plan.poll).toBe(false);
    expect(plan.topics).toHaveLength(LIVE_PROJECT_BUDGET + 1);
    expect(plan.topics.at(-1)).toBe('admin');
    expect(planLive({ projectIds: ids(2), isAdmin: false }).topics).toEqual([
      'project:p0',
      'project:p1',
    ]);
  });

  test('past the budget: no subscriptions, poll instead', () => {
    expect(
      planLive({ projectIds: ids(LIVE_PROJECT_BUDGET + 1), isAdmin: true }),
    ).toEqual({ topics: [], poll: true });
  });

  test('a member of no project still gets admin when admin', () => {
    expect(planLive({ projectIds: [], isAdmin: true }).topics).toEqual([
      'admin',
    ]);
    expect(planLive({ projectIds: [], isAdmin: false }).topics).toEqual([]);
  });
});

describe('presentation', () => {
  test('actor names', () => {
    expect(actorName(item({ actorType: 'user', actorEmail: 'a@b.c' }))).toBe(
      'a@b.c',
    );
    expect(actorName(item({ actorType: 'user' }))).toBe('unknown user');
    expect(actorName(item({ actorType: 'system' }))).toBe('system');
    const runner = item({ actorType: 'runner', actorId: 'cmv6f76c2000101' });
    expect(actorName(runner, new Map([['cmv6f76c2000101', 'luna']]))).toBe(
      'luna',
    );
    // Never a raw id (R2).
    expect(actorName(runner)).toBe('runner');
    expect(actorName(runner, new Map())).toBe('runner');
  });

  test('meta lists project, slot, issue and PR, but no event code', () => {
    const names = new Map([['p1', 'Alpha']]);
    expect(itemMeta(item({ slot: 'i1', issue: 7, prNumber: 9 }), names)).toBe(
      'Fleet · Alpha · slot i1 · #7 · PR #9',
    );
    expect(itemMeta(item({ projectId: null }), names)).toContain('no project');
  });

  test('links must be in-app paths', () => {
    expect(safeLink('/projects/p1/history/r1')).toBe('/projects/p1/history/r1');
    expect(safeLink('//evil.example')).toBeUndefined();
    expect(safeLink('https://evil.example')).toBeUndefined();
    expect(safeLink('javascript:alert(1)')).toBeUndefined();
    expect(safeLink(null)).toBeUndefined();
  });

  test('timeline item carries tone and link', () => {
    const t = toTimelineItem(
      item({ severity: 'danger', link: '/projects/p1/fleet' }),
    );
    expect(t.tone).toBe('danger');
    expect(t.href).toBe('/projects/p1/fleet');
  });
});

describe('activityHref', () => {
  test("a slot's item opens its panel in front on Fleet", () => {
    expect(
      activityHref(item({ slot: 'i185', link: '/projects/p1/fleet' })),
    ).toBe('/projects/p1/fleet?open=i185&focus=i185');
  });

  test('any other link is the API one, as it is', () => {
    expect(
      activityHref(item({ slot: 'i185', link: '/projects/p1/schedules' })),
    ).toBe('/projects/p1/schedules');
    expect(activityHref(item({ link: '/projects/p1/fleet' }))).toBe(
      '/projects/p1/fleet',
    );
  });

  test('a fleet link of another project, or a name that is no slot, is not rewritten', () => {
    expect(
      activityHref(item({ slot: 'i185', link: '/projects/p2/fleet' })),
    ).toBe('/projects/p2/fleet');
    expect(
      activityHref(item({ slot: 'Bad Name', link: '/projects/p1/fleet' })),
    ).toBe('/projects/p1/fleet');
  });

  test('never an outside link', () => {
    expect(
      activityHref(item({ slot: 'i1', link: '//evil.example' })),
    ).toBeUndefined();
  });

  test('the timeline item uses it', () => {
    expect(
      toTimelineItem(item({ slot: 'i2', link: '/projects/p1/fleet' })).href,
    ).toBe('/projects/p1/fleet?open=i2&focus=i2');
  });
});

describe('prLink', () => {
  test('the checkpoint prUrl wins, https only', () => {
    expect(
      prLink(item({ data: { prUrl: 'https://github.com/a/b/pull/7' } })),
    ).toBe('https://github.com/a/b/pull/7');
    expect(prLink(item({ data: { prUrl: 'javascript:alert(1)' } }))).toBe(
      undefined,
    );
    expect(
      prLink(item({ data: { prUrl: 'http://github.com/a/b/pull/7' } })),
    ).toBe(undefined);
  });

  test('falls back to the URL at the end of the title', () => {
    expect(
      prLink(
        item({
          title: 'i1: pull request open — https://github.com/a/b/pull/3',
        }),
      ),
    ).toBe('https://github.com/a/b/pull/3');
  });

  test('no URL, no link', () => {
    expect(prLink(item({ title: 'i1: blocked', data: {} }))).toBe(undefined);
  });
});

describe('itemTitle', () => {
  test('a trailing PR URL becomes the number', () => {
    expect(
      itemTitle(
        item({
          title:
            'i185: pull request open — https://github.com/acme/app/pull/205',
        }),
      ),
    ).toEqual({ title: 'i185: pull request open', prNumber: 205 });
  });

  test("the item's own number wins over the URL's", () => {
    expect(
      itemTitle(
        item({
          title: 'i1: pull request open https://github.com/a/b/pull/3/files',
          prNumber: 4,
        }),
      ),
    ).toEqual({ title: 'i1: pull request open', prNumber: 4 });
  });

  test('a title without a PR URL is left as it is', () => {
    expect(itemTitle(item({ title: 'i1: blocked on review' }))).toEqual({
      title: 'i1: blocked on review',
      prNumber: null,
    });
  });

  test('a title that is only the URL keeps it rather than going blank', () => {
    const only = 'https://github.com/a/b/pull/7';
    expect(itemTitle(item({ title: only })).title).toBe(only);
  });

  test('meta and the timeline item read the number from the URL', () => {
    const titled = item({
      title: 'i9: pull request open — https://github.com/a/b/pull/12',
    });
    expect(itemMeta(titled)).toContain('PR #12');
    expect(toTimelineItem(titled).title).toBe('i9: pull request open');
  });
});

describe('filters in the URL', () => {
  test('a project feed never writes or reads the project', () => {
    const params = new URLSearchParams('project=p9&category=fleet&tab=x');
    expect(PROJECT_ACTIVITY_FILTER_CODEC.parse(params).projectId).toBe('');
    expect(
      PROJECT_ACTIVITY_FILTER_CODEC.search({
        ...EMPTY_ACTIVITY_FILTERS,
        projectId: 'p9',
        slot: 'i1',
      }),
    ).toBe('?slot=i1');
    expect(PROJECT_ACTIVITY_FILTER_CODEC.keys).not.toContain('project');
    expect(ACTIVITY_FILTER_CODEC.keys).toContain('project');
  });

  test('chips name each filter in force', () => {
    const defs = activityChipDefs({
      project: () => 'Alpha',
      actor: () => 'dev@example.test',
    });
    const labels = defs.flatMap(
      (d) =>
        d.label({
          projectId: 'p1',
          category: 'fleet',
          type: 'pr.opened',
          actor: 'u1',
          slot: 'i3',
          fromDate: '2026-10-01',
          toDate: '',
        }) ?? [],
    );
    expect(labels).toEqual([
      'Project: Alpha',
      'Category: Fleet',
      'Type: PR opened',
      'Actor: dev@example.test',
      'Slot: i3',
      'From 2026-10-01',
    ]);
  });
});

describe('filters', () => {
  test('a query with no value is not a filter', () => {
    expect(hasActivityFilters({})).toBe(false);
    expect(hasActivityFilters({ type: 'pr.merged' })).toBe(true);
  });

  test('the URL round-trips the form, in days', () => {
    const form = {
      ...EMPTY_ACTIVITY_FILTERS,
      projectId: 'p1',
      category: 'fleet',
      slot: 'i154',
      fromDate: '2026-10-01',
    };
    const search = formSearch(form);
    expect(search).toBe('?project=p1&category=fleet&slot=i154&from=2026-10-01');
    expect(formFromSearch(new URLSearchParams(search))).toEqual(form);
    expect(formSearch(EMPTY_ACTIVITY_FILTERS)).toBe('');
  });

  test('an unreadable URL value is dropped', () => {
    expect(
      formFromSearch(
        new URLSearchParams('category=bogus&from=yesterday&slot=%20i1%20'),
      ),
    ).toEqual({ ...EMPTY_ACTIVITY_FILTERS, slot: 'i1' });
    expect(
      formFromSearch(new URLSearchParams(`type=${'x'.repeat(201)}`)),
    ).toEqual(EMPTY_ACTIVITY_FILTERS);
  });

  test('"More filters" counts what it holds', () => {
    expect(moreFilterCount(EMPTY_ACTIVITY_FILTERS)).toBe(0);
    expect(
      moreFilterCount({
        ...EMPTY_ACTIVITY_FILTERS,
        projectId: 'p1',
        slot: 'i1',
        toDate: '2026-10-02',
      }),
    ).toBe(2);
  });
});

describe('typeLabel', () => {
  test('reads an event code as words', () => {
    expect(typeLabel('pr.checks_changed')).toBe('PR checks changed');
    expect(typeLabel('slot.checkpoint')).toBe('Slot checkpoint');
    expect(typeLabel('runner.pairing_code')).toBe('Runner pairing code');
  });

  test('every option has a label and no code is listed twice', () => {
    const values = TYPE_OPTIONS.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
    expect(TYPE_OPTIONS.every((o) => o.label !== '')).toBe(true);
  });

  test('the Steward group holds every incident type, once, and only there (#447 D15)', () => {
    expect(STEWARD_TYPE_OPTIONS.map((o) => o.value)).toEqual([
      ...STEWARD_ACTIVITY_TYPES,
    ]);
    expect(STEWARD_TYPE_OPTIONS.every((o) => o.label !== '')).toBe(true);
    const others = new Set(TYPE_OPTIONS.map((o) => o.value));
    for (const type of STEWARD_ACTIVITY_TYPES) {
      expect(others.has(type)).toBe(false);
    }
  });
});

describe('groupRows', () => {
  const at = (hour: number) => new Date(2026, 9, 13, hour, 0, 0).toISOString();

  test('folds consecutive items of one slot on one day', () => {
    const rows = groupRows([
      item({ id: '5', slot: 'i154', ts: at(15) }),
      item({ id: '4', slot: 'i154', ts: at(14) }),
      item({ id: '3', slot: 'i154', ts: at(13) }),
      item({ id: '2', slot: 'i140', ts: at(12) }),
      item({ id: '1', slot: 'i154', ts: at(11) }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['group', 'item', 'item']);
    const [group] = rows;
    expect(group).toMatchObject({ id: 'group-3', label: 'i154' });
    if (group.kind === 'group') {
      expect(group.items.map((i) => i.id)).toEqual(['5', '4', '3']);
    }
  });

  test('groups by PR when there is no slot, never across days or subjects', () => {
    const rows = groupRows([
      item({ id: '4', prNumber: 96, ts: at(15) }),
      item({ id: '3', prNumber: 96, ts: at(14) }),
      item({ id: '2', ts: at(13) }),
      item({ id: '1', ts: at(12) }),
      item({ id: '0', prNumber: 96, ts: new Date(2026, 9, 12).toISOString() }),
    ]);
    expect(rows.map((r) => (r.kind === 'group' ? r.label : r.item.id))).toEqual(
      ['PR #96', '2', '1', '0'],
    );
  });

  test('the group id survives newer items arriving on top', () => {
    const older = [
      item({ id: '2', slot: 'i1', ts: at(12) }),
      item({ id: '1', slot: 'i1', ts: at(11) }),
    ];
    const newer = [item({ id: '3', slot: 'i1', ts: at(13) }), ...older];
    const id = (rows: ReturnType<typeof groupRows>) =>
      rows[0].kind === 'group' ? rows[0].id : null;
    expect(id(groupRows(newer))).toBe(id(groupRows(older)));
  });
});
