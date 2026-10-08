import { describe, expect, test } from 'bun:test';
import type { ActivityItem } from '@agentdock/shared';
import {
  actorName,
  itemMeta,
  LIVE_PROJECT_BUDGET,
  matchesQuery,
  mergeItems,
  parseLiveItem,
  planLive,
  queryString,
  safeLink,
  toActivityQuery,
  toTimelineItem,
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
    expect(
      actorName(item({ actorType: 'runner', actorId: 'abcdef123456' })),
    ).toBe('runner abcdef12');
  });

  test('meta lists project, slot, issue and PR', () => {
    const names = new Map([['p1', 'Alpha']]);
    expect(itemMeta(item({ slot: 'i1', issue: 7, prNumber: 9 }), names)).toBe(
      'Fleet · Alpha · slot i1 · #7 · PR #9 · pr.opened',
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
