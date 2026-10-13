import { describe, expect, test } from 'bun:test';
import type {
  ProjectSummary,
  RunSummary,
  SessionSummary,
} from '@agentdock/shared';
import { visibleNav } from './nav';
import { type PaletteInput, paletteGroups } from './palette';

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
    themeLabel: 'System',
    ...overrides,
  };
}

const titles = (groups: ReturnType<typeof paletteGroups>) =>
  groups.map((group) => group.title);
const labelsIn = (groups: ReturnType<typeof paletteGroups>, id: string) =>
  groups.find((group) => group.id === id)?.items.map((item) => item.label) ??
  [];

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
      ['go:/projects/p1/history/r1', '#155 · i155'],
    ]);
  });

  test('the admin Settings is told apart from the project Settings', () => {
    const groups = paletteGroups(input({ query: 'settings', projectId: 'p1' }));
    const admin = groups
      .find((group) => group.id === 'pages')
      ?.items.find((item) => item.id === 'go:/admin/settings');
    expect(admin?.hint).toBe('Admin');
  });
});
