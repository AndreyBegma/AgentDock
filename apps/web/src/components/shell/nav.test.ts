import { describe, expect, test } from 'bun:test';
import { isActive, projectIdOf, visibleNav } from './nav';

const labels = (role: 'admin' | 'viewer', path: string) =>
  visibleNav(role, path).flatMap((section) =>
    section.entries.map((entry) => `${section.id}/${entry.label}`),
  );

describe('visibleNav', () => {
  test('a viewer gets no Admin section', () => {
    const sections = visibleNav('viewer', '/').map((section) => section.id);
    expect(sections).toEqual(['overview', 'sessions', 'usage']);
  });

  test('an admin gets Runners, Users, Audit, Prices, Integrations and Settings', () => {
    expect(labels('admin', '/')).toEqual([
      'overview/Overview',
      'overview/Projects',
      'overview/Activity',
      'overview/Skills',
      'sessions/Sessions',
      'usage/Usage',
      'admin/Runners',
      'admin/Users',
      'admin/Schedules',
      'admin/Audit',
      'admin/Prices',
      'admin/Integrations',
      'admin/Settings',
    ]);
  });

  test('a viewer sees Usage but never Prices', () => {
    expect(labels('viewer', '/')).toContain('usage/Usage');
    expect(labels('viewer', '/').join()).not.toContain('Prices');
  });

  test('a viewer sees Projects, and Fleet and Settings inside a project', () => {
    expect(labels('viewer', '/')).toEqual([
      'overview/Overview',
      'overview/Projects',
      'overview/Activity',
      'sessions/Sessions',
      'usage/Usage',
    ]);
    const inProject = labels('viewer', '/projects/p1/settings');
    expect(inProject).toContain('project/Fleet');
    expect(inProject).toContain('project/Queue');
    expect(inProject).toContain('project/Approvals');
    expect(inProject).toContain('project/Activity');
    expect(inProject).toContain('project/History');
    expect(inProject).toContain('project/Skills');
    expect(inProject).toContain('project/Schedules');
    expect(inProject).toContain('project/Settings');
  });

  test('the catalog is for operators; a viewer sees only the project inventory', () => {
    expect(labels('viewer', '/').join()).not.toContain('overview/Skills');
    const skills = visibleNav('viewer', '/projects/p1/fleet')
      .flatMap((section) => section.entries)
      .find((entry) => entry.id === 'project-skills');
    expect(skills?.resolvedHref).toBe('/projects/p1/skills');
  });

  test('Fleet links to the current project', () => {
    const fleet = visibleNav('viewer', '/projects/p1/fleet')
      .flatMap((section) => section.entries)
      .find((entry) => entry.id === 'fleet');
    expect(fleet?.resolvedHref).toBe('/projects/p1/fleet');
  });

  test('a viewer never sees Audit', () => {
    expect(labels('viewer', '/').join()).not.toContain('Audit');
  });
});

describe('projectIdOf / isActive', () => {
  test('reads the project id only under /projects', () => {
    expect(projectIdOf('/projects/p1/fleet')).toBe('p1');
    expect(projectIdOf('/admin/users')).toBeNull();
  });

  test('Overview is active only on /', () => {
    expect(isActive('/', '/')).toBe(true);
    expect(isActive('/', '/admin/users')).toBe(false);
    expect(isActive('/admin/users', '/admin/users')).toBe(true);
    expect(isActive('/admin/users', '/admin/users-x')).toBe(false);
  });
});
