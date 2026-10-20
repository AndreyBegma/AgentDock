import { describe, expect, test } from 'bun:test';
import type {
  PlanSummary,
  ProjectSummary,
  RunSummary,
  SessionSummary,
} from '@agentdock/shared';
import { visibleNav } from './nav';
import { askItem, type PaletteInput, paletteGroups } from './palette';

const project = (id: string, displayName: string) =>
  ({ id, displayName, repo: `acme/${id}` }) as ProjectSummary;

const PROJECTS = [project('p1', 'AgentDock'), project('p2', 'Glass')];

function input(overrides: Partial<PaletteInput> = {}): PaletteInput {
  const path = overrides.projectId ? `/projects/${overrides.projectId}` : '/';
  return {
    query: '',
    role: 'admin',
    sections: visibleNav('admin', path),
    projects: PROJECTS,
    projectId: null,
    recent: { sessions: [], runs: [] },
    plans: [],
    themeLabel: 'System',
    ...overrides,
  };
}

const titles = (groups: ReturnType<typeof paletteGroups>) =>
  groups.map((group) => group.title);
const labelsIn = (groups: ReturnType<typeof paletteGroups>, id: string) =>
  groups.find((group) => group.id === id)?.items.map((item) => item.label) ??
  [];

const plan = (id: string, title: string, updatedAt: string) =>
  ({ id, projectId: 'p1', title, updatedAt }) as PlanSummary;

describe('paletteGroups: Plans', () => {
  const plans = [
    plan('a', 'Old plan', '2026-10-01T00:00:00Z'),
    plan('b', 'Ship the shell', '2026-10-14T00:00:00Z'),
  ];

  test('the project plans are a group, newest first, opening the plan', () => {
    const groups = paletteGroups(input({ projectId: 'p1', plans }));
    expect(labelsIn(groups, 'plans')).toEqual(['Ship the shell', 'Old plan']);
    const first = groups.find((group) => group.id === 'plans')?.items[0];
    expect(first?.id).toBe('go:/projects/p1/planner/b');
  });

  test('a query narrows the plans, and "plan" finds them all', () => {
    expect(
      labelsIn(
        paletteGroups(input({ projectId: 'p1', plans, query: 'shell' })),
        'plans',
      ),
    ).toEqual(['Ship the shell']);
    expect(
      labelsIn(
        paletteGroups(input({ projectId: 'p1', plans, query: 'plan' })),
        'plans',
      ),
    ).toHaveLength(2);
  });

  test('no plans, no group', () => {
    expect(titles(paletteGroups(input({ projectId: 'p1' })))).not.toContain(
      'Plans',
    );
  });

  test('the admin page reads "Planner instructions"', () => {
    expect(labelsIn(paletteGroups(input()), 'admin')).toContain(
      'Planner instructions',
    );
  });
});

describe('paletteGroups', () => {
  test('group titles are unique and no row repeats its group title', () => {
    const groups = paletteGroups(input({ projectId: 'p1' }));
    expect(new Set(titles(groups)).size).toBe(groups.length);
    for (const group of groups) {
      for (const item of group.items) expect(item.hint).not.toBe(group.title);
    }
  });

  test('inside a project, its pages read "Project › Page"', () => {
    const groups = paletteGroups(input({ projectId: 'p1' }));
    expect(labelsIn(groups, 'project-pages')).toContain('AgentDock › Fleet');
    expect(labelsIn(groups, 'project-pages').join()).not.toContain('Glass');
  });

  test('a query finds the pages of any project', () => {
    const groups = paletteGroups(input({ query: 'glass fleet' }));
    expect(labelsIn(groups, 'project-pages')).toEqual(['Glass › Fleet']);
  });

  test('outside a project and with no query, no project pages', () => {
    expect(labelsIn(paletteGroups(input()), 'project-pages')).toEqual([]);
  });

  test('recent sessions and runs are listed by name', () => {
    const groups = paletteGroups(
      input({
        recent: {
          sessions: [
            {
              id: 's1',
              title: 'Fix the login loop',
              slotName: null,
              projectName: 'AgentDock',
            } as SessionSummary,
          ],
          runs: [
            {
              id: 'r1',
              projectId: 'p1',
              issue: 155,
              slot: 'i155',
              title: null,
            } as RunSummary,
          ],
        },
      }),
    );
    const recent = groups.find((group) => group.id === 'recent');
    expect(recent?.items.map((item) => [item.id, item.label])).toEqual([
      ['go:/sessions/s1', 'Fix the login loop'],
      ['go:/projects/p1/activity?tab=runs&run=r1', '#155 · i155'],
    ]);
  });

  test('a planner run shows as its plan, once for all its turns (#213)', () => {
    const turn = (id: string) =>
      ({
        id,
        kind: 'plan',
        projectId: 'p1',
        issue: null,
        slot: null,
        title: 'Plan decompose',
        planId: 'pl1',
      }) as RunSummary;
    const groups = paletteGroups(
      input({
        projectId: 'p1',
        plans: [
          {
            id: 'pl1',
            projectId: 'p1',
            title: 'CSV exporter',
            updatedAt: '2026-10-14T10:00:00.000Z',
          } as PlanSummary,
        ],
        recent: { sessions: [], runs: [turn('r2'), turn('r1')] },
      }),
    );
    const recent = groups.find((group) => group.id === 'recent');
    expect(recent?.items.map((item) => [item.id, item.label])).toEqual([
      ['go:/projects/p1/planner/pl1', 'CSV exporter'],
    ]);
  });

  test('the admin Settings is told apart from the project Settings by its group', () => {
    const groups = paletteGroups(input({ query: 'settings', projectId: 'p1' }));
    expect(labelsIn(groups, 'admin')).toEqual(['Settings']);
    expect(labelsIn(groups, 'project-pages')).toEqual([
      'AgentDock › Settings',
      'Glass › Settings',
    ]);
    expect(labelsIn(groups, 'pages')).not.toContain('Settings');
  });

  test('no hint repeats down a group', () => {
    for (const group of paletteGroups(input({ projectId: 'p1' }))) {
      const hints = group.items.map((item) => item.hint).filter(Boolean);
      if (hints.length > 1) expect(new Set(hints).size).toBeGreaterThan(1);
    }
  });
});

describe('askItem (#660)', () => {
  test('offers any query as a question, last', () => {
    const groups = paletteGroups(
      input({ query: 'Какие карточки упали на проверках?' }),
    );
    expect(groups.at(-1)).toMatchObject({
      id: 'ask',
      title: 'Ask the Board',
      items: [
        {
          id: 'ask:Какие карточки упали на проверках?',
          label: 'Ask the Board: “Какие карточки упали на проверках?”',
        },
      ],
    });
  });

  test('offers nothing for an empty or a one-letter query', () => {
    expect(askItem('')).toBeNull();
    expect(askItem(' a ')).toBeNull();
  });
});
