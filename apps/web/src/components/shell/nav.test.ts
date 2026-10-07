import { describe, expect, test } from 'bun:test';
import { isActive, projectIdOf, visibleNav } from './nav';

const labels = (role: 'admin' | 'viewer', path: string) =>
  visibleNav(role, path).flatMap((section) =>
    section.entries.map((entry) => `${section.id}/${entry.label}`),
  );

describe('visibleNav', () => {
  test('a viewer gets no Admin section', () => {
    const sections = visibleNav('viewer', '/').map((section) => section.id);
    expect(sections).toEqual(['overview']);
  });

  test('an admin gets Runners, Users, Audit and Settings', () => {
    expect(labels('admin', '/')).toEqual([
      'overview/Overview',
      'admin/Runners',
      'admin/Users',
      'admin/Audit',
      'admin/Settings',
    ]);
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
