import { describe, expect, test } from 'bun:test';
import type { ActivityItem } from '@nautelle/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { type FeedRow } from '../../../lib/activity/format';
import { toEntries } from './feed-entries';

const item = (patch: Partial<ActivityItem> = {}): ActivityItem => ({
  id: '1',
  ts: '2026-10-08T10:00:00.000Z',
  projectId: 'p1',
  category: 'fleet',
  type: 'slot.checkpoint',
  severity: 'info',
  title: 'i185: pull request open',
  actorType: 'orchestrator',
  actorId: null,
  actorEmail: null,
  slot: 'i185',
  issue: 185,
  prNumber: 205,
  link: '/projects/p1/fleet',
  data: {},
  ...patch,
});

const names = {
  projects: new Map<string, string>(),
  runners: new Map<string, string>(),
};

const entry = (patch: Partial<ActivityItem>) => {
  const rows: FeedRow[] = [{ kind: 'item', item: item(patch) }];
  return toEntries(rows, new Set(), () => {}, names, true)[0];
};

describe('toEntries pull request link', () => {
  test('a PR with a URL is an action beside the row, not inside its meta', () => {
    const e = entry({ data: { prUrl: 'https://github.com/a/b/pull/205' } });
    expect(e.href).toBe('/projects/p1/fleet?open=i185&focus=i185');
    const actions = renderToStaticMarkup(<div>{e.actions}</div>);
    expect(actions).toContain('href="https://github.com/a/b/pull/205"');
    expect(actions).toContain('#');
    const meta = renderToStaticMarkup(<div>{e.meta}</div>);
    expect(meta).not.toContain('<a ');
    expect(meta).not.toContain('Pull request');
  });

  test('a PR without a URL stays a plain chip with no action', () => {
    const e = entry({});
    expect(e.actions).toBeUndefined();
    expect(renderToStaticMarkup(<div>{e.meta}</div>)).toContain('Pull request');
  });
});
