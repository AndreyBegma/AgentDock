import { describe, expect, test } from 'bun:test';
import type { TerminalSetupNeed } from '../setup/format';
import type { NeedsYouItem } from './dashboard';
import { groupNeeds, needsRows, orderNeeds, projectsLabel } from './needs-rows';

const item = (over: Partial<NeedsYouItem> & { key: string }): NeedsYouItem => ({
  kind: 'blocked',
  projectId: 'p1',
  projectName: 'Project p1',
  title: 'Slot i1',
  reason: 'Blocked — waiting for a decision',
  href: '/projects/p1/fleet',
  since: '2026-10-13T08:00:00.000Z',
  ...over,
});

const profile = (id: string): NeedsYouItem =>
  item({
    key: `profile:${id}`,
    kind: 'profile',
    projectId: id,
    projectName: `Project ${id}`,
    title: 'No default runtime profile',
    reason: 'Choose one so the orchestrator can start',
    href: `/projects/${id}/settings?tab=orchestrator`,
    since: null,
  });

const setup = (id: string): TerminalSetupNeed => ({
  key: `terminal-setup:${id}`,
  projectId: id,
  projectName: `Project ${id}`,
  title: 'Terminal sessions don’t reach the Board',
  reason: '2 steps',
  href: `/projects/${id}/settings?tab=sessions`,
});

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);

describe('groupNeeds', () => {
  test('eight terminal-setup rows become one row of eight projects', () => {
    const rows = groupNeeds([], ids(8).map(setup));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.members).toHaveLength(8);
    expect(projectsLabel(rows[0]?.members.length ?? 0)).toBe('8 projects');
  });

  test('four runtime-profile rows become one row of four projects', () => {
    const rows = groupNeeds(ids(4).map(profile), []);
    expect(rows).toHaveLength(1);
    expect(projectsLabel(rows[0]?.members.length ?? 0)).toBe('4 projects');
  });

  test('each member keeps the href the single row had', () => {
    const [row] = groupNeeds([], ids(3).map(setup));
    expect(row?.members.map((m) => [m.projectName, m.href])).toEqual([
      ['Project p1', '/projects/p1/settings?tab=sessions'],
      ['Project p2', '/projects/p2/settings?tab=sessions'],
      ['Project p3', '/projects/p3/settings?tab=sessions'],
    ]);
  });

  test('a profile need and a terminal-setup need stay apart', () => {
    const rows = groupNeeds([profile('p1'), profile('p2')], ids(2).map(setup));
    expect(rows.map((r) => [r.kind, r.members.length])).toEqual([
      ['profile', 2],
      ['terminal-setup', 2],
    ]);
  });

  test('slots with the same title in two projects are not merged', () => {
    const rows = groupNeeds(
      [
        item({ key: 'blocked:a', projectId: 'p1' }),
        item({ key: 'blocked:b', projectId: 'p2' }),
      ],
      [],
    );
    expect(rows).toHaveLength(2);
  });

  test('a lone setup need is a row of one', () => {
    const [row] = groupNeeds([], [setup('p1')]);
    expect(row?.members).toHaveLength(1);
  });
});

describe('orderNeeds', () => {
  test('failed and blocked, prompts, approvals, then setup', () => {
    const rows = needsRows(
      [
        profile('p1'),
        item({
          key: 'approval:a',
          kind: 'approval',
          title: 'PR #7',
          since: '2026-10-13T01:00:00.000Z',
        }),
        item({
          key: 'prompt:a',
          kind: 'prompt',
          title: 'Slot i2',
          since: '2026-10-13T02:00:00.000Z',
        }),
        item({
          key: 'failed:a',
          kind: 'failed',
          title: 'Slot i3',
          since: '2026-10-13T09:00:00.000Z',
        }),
      ],
      ids(8).map(setup),
    );
    expect(rows.map((r) => r.kind)).toEqual([
      'failed',
      'prompt',
      'approval',
      'profile',
      'terminal-setup',
    ]);
  });

  test('oldest first within a severity, blocked and failed together', () => {
    const rows = orderNeeds(
      groupNeeds(
        [
          item({
            key: 'blocked:new',
            title: 'new',
            since: '2026-10-13T09:00:00.000Z',
          }),
          item({
            key: 'failed:old',
            kind: 'failed',
            title: 'old',
            since: '2026-10-13T07:00:00.000Z',
          }),
          item({
            key: 'blocked:mid',
            title: 'mid',
            since: '2026-10-13T08:00:00.000Z',
          }),
        ],
        [],
      ),
    );
    expect(rows.map((r) => r.title)).toEqual(['old', 'mid', 'new']);
  });

  test('setup rows keep their order, after every dated row', () => {
    const rows = needsRows(
      [item({ key: 'blocked:a', title: 'Slot i9' })],
      [setup('p2'), setup('p1')],
    );
    expect(rows[0]?.title).toBe('Slot i9');
    expect(rows[1]?.members.map((m) => m.projectId)).toEqual(['p2', 'p1']);
  });

  test('a blocked slot sits above setup needs however new it is', () => {
    const rows = needsRows(
      [item({ key: 'blocked:a', since: '2030-01-01T00:00:00.000Z' })],
      [setup('p1')],
    );
    expect(rows.map((r) => r.kind)).toEqual(['blocked', 'terminal-setup']);
  });
});

describe('projectsLabel', () => {
  test('singular and plural', () => {
    expect(projectsLabel(1)).toBe('1 project');
    expect(projectsLabel(8)).toBe('8 projects');
  });
});
