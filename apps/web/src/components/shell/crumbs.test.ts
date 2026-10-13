import { describe, expect, test } from 'bun:test';
import { crumbsFor, pageTitleOf, runLabel, sessionLabel } from './crumbs';

const PROJECT = 'cmg7x2p0q0000abcdxyz12345';
const RUN = 'cmg8a1b2c0003efghijk67890';
const SESSION = 'cmg9z9y8x0007lmnopq11111';

const labels = (path: string, names = new Map<string, string>()) =>
  crumbsFor(path, names).map((crumb) => crumb.label);

describe('crumbsFor', () => {
  test('the overview is one crumb', () => {
    expect(labels('/')).toEqual(['Overview']);
  });

  test('a project reads as its name, its page as the nav label', () => {
    const names = new Map([[PROJECT, 'AgentDock']]);
    expect(labels(`/projects/${PROJECT}/fleet`, names)).toEqual([
      'Projects',
      'AgentDock',
      'Fleet',
    ]);
  });

  test('a run reads as its issue and slot', () => {
    const names = new Map([
      [PROJECT, 'AgentDock'],
      [RUN, '#155 · i155'],
    ]);
    expect(labels(`/projects/${PROJECT}/history/${RUN}`, names)).toEqual([
      'Projects',
      'AgentDock',
      'History',
      '#155 · i155',
    ]);
  });

  test('an id never shows as text, even before its name is known', () => {
    const trail = labels(`/projects/${PROJECT}/history/${RUN}`);
    expect(trail).toEqual(['Projects', 'Project', 'History', 'Run']);
    expect(trail.join(' ')).not.toMatch(/cmg/i);
    expect(labels(`/sessions/${SESSION}`)).toEqual(['Sessions', 'Session']);
    expect(labels(`/projects/${PROJECT}/skills/runs/${RUN}`)).toEqual([
      'Projects',
      'Project',
      'Skills',
      'Runs',
      'Skill run',
    ]);
  });

  test('a session reads as its name', () => {
    const names = new Map([[SESSION, 'Fix the login loop']]);
    expect(labels(`/sessions/${SESSION}`, names)).toEqual([
      'Sessions',
      'Fix the login loop',
    ]);
  });

  test('the admin integration pages have their own names', () => {
    expect(labels('/admin/integrations/github')).toEqual([
      'Admin',
      'Integrations',
      'GitHub App',
    ]);
  });

  test('the last crumb and the pages that do not exist are not links', () => {
    const crumbs = crumbsFor(`/projects/${PROJECT}/skills/runs/${RUN}`);
    expect(crumbs.map((crumb) => crumb.href)).toEqual([
      '/projects',
      `/projects/${PROJECT}`,
      `/projects/${PROJECT}/skills`,
      undefined,
      undefined,
    ]);
    expect(crumbsFor('/admin/users')[0]?.href).toBeUndefined();
  });
});

describe('pageTitleOf', () => {
  test('a project page carries the project name', () => {
    const names = new Map([[PROJECT, 'AgentDock']]);
    expect(pageTitleOf(crumbsFor(`/projects/${PROJECT}/fleet`, names))).toBe(
      'Fleet · AgentDock',
    );
  });

  test('anywhere else it is the page', () => {
    expect(pageTitleOf(crumbsFor('/admin/runners'))).toBe('Runners');
    expect(pageTitleOf(crumbsFor('/projects'))).toBe('Projects');
  });
});

describe('runLabel / sessionLabel', () => {
  test('issue and slot, then issue, title, slot, kind', () => {
    expect(runLabel({ issue: 155, slot: 'i155', title: 'x' })).toBe(
      '#155 · i155',
    );
    expect(runLabel({ issue: 155, slot: null, title: null })).toBe('#155');
    expect(runLabel({ issue: null, slot: 'i3', title: 'Nightly' })).toBe(
      'Nightly',
    );
    expect(runLabel({ issue: null, slot: null, title: null })).toBe('Run');
  });

  test('a long session title is clipped', () => {
    const label = sessionLabel({ title: 'a'.repeat(80), slotName: null });
    expect(label).toHaveLength(48);
    expect(label.endsWith('…')).toBe(true);
    expect(sessionLabel({ title: null, slotName: 'i19' })).toBe('i19');
  });
});
