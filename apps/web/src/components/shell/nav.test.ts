import { describe, expect, test } from 'bun:test';
import {
  activeEntryId,
  isActive,
  isWideEntry,
  projectIdOf,
  tabBarSplit,
  visibleNav,
} from './nav';

const labels = (role: 'admin' | 'viewer', path: string) =>
  visibleNav(role, path).flatMap((section) =>
    section.entries.map((entry) => `${section.id}/${entry.label}`),
  );

const activeAt = (role: 'admin' | 'viewer', path: string) =>
  activeEntryId(visibleNav(role, path), path);

describe('visibleNav', () => {
  test('a viewer gets the workspace and no Admin section', () => {
    const sections = visibleNav('viewer', '/').map((section) => section.id);
    expect(sections).toEqual(['workspace']);
  });

  test('the workspace comes first, then the project, then Admin', () => {
    const sections = visibleNav('admin', '/projects/p1/fleet').map(
      (section) => section.id,
    );
    expect(sections).toEqual(['workspace', 'project', 'admin']);
  });

  test('an admin gets the workspace and the Admin pages, Integrations once', () => {
    expect(labels('admin', '/')).toEqual([
      'workspace/Overview',
      'workspace/Projects',
      'workspace/Activity',
      'workspace/Work',
      'workspace/Sessions',
      'workspace/Usage',
      'workspace/Workflows',
      'workspace/Skills',
      'admin/Runners',
      'admin/Users',
      'admin/Schedules',
      'admin/Budgets',
      'admin/Planner instructions',
      'admin/Audit',
      'admin/Prices',
      'admin/Integrations',
      'admin/Settings',
    ]);
  });

  test('Integrations opens the hub, not one of its pages', () => {
    const integrations = visibleNav('admin', '/')
      .flatMap((section) => section.entries)
      .find((entry) => entry.id === 'integrations');
    expect(integrations?.resolvedHref).toBe('/admin/integrations');
  });

  test('a viewer sees Usage but never Prices', () => {
    expect(labels('viewer', '/')).toContain('workspace/Usage');
    expect(labels('viewer', '/').join()).not.toContain('Prices');
  });

  test('a viewer sees Projects, and Fleet and Settings inside a project', () => {
    expect(labels('viewer', '/')).toEqual([
      'workspace/Overview',
      'workspace/Projects',
      'workspace/Activity',
      'workspace/Work',
      'workspace/Sessions',
      'workspace/Usage',
      'workspace/Workflows',
    ]);
    expect(labels('viewer', '/').join()).not.toContain('Tasks');
    const inProject = labels('viewer', '/projects/p1/settings');
    for (const page of [
      'Fleet',
      'Planner',
      'Work',
      'Queue',
      'Approvals',
      'Activity',
      'History',
      'Skills',
      'Schedules',
      'Settings',
    ]) {
      expect(inProject).toContain(`project/${page}`);
    }
  });

  test('the catalog is for operators; a viewer sees only the project inventory', () => {
    expect(labels('viewer', '/').join()).not.toContain('workspace/Skills');
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

describe('activeEntryId: one active item', () => {
  test('inside a project only the sub-page is active, never Projects', () => {
    expect(activeAt('admin', '/projects/p1/fleet')).toBe('fleet');
    expect(activeAt('admin', '/projects/p1/history/r1')).toBe('history');
    expect(activeAt('admin', '/projects/p1/skills/runs/r1')).toBe(
      'project-skills',
    );
  });

  test('/projects is active only on the list itself', () => {
    expect(activeAt('viewer', '/projects')).toBe('projects');
    expect(activeAt('viewer', '/projects/p1')).toBeNull();
  });

  test('the project Activity does not light the workspace Activity', () => {
    expect(activeAt('viewer', '/activity')).toBe('activity');
    expect(activeAt('viewer', '/projects/p1/activity')).toBe(
      'project-activity',
    );
  });

  test('the Integrations hub stays active on its pages', () => {
    expect(activeAt('admin', '/admin/integrations')).toBe('integrations');
    expect(activeAt('admin', '/admin/integrations/webhooks')).toBe(
      'integrations',
    );
  });

  test('the project Work entry lights its own entry, not the Queue', () => {
    expect(activeAt('viewer', '/projects/p1/board')).toBe('board');
    expect(activeAt('viewer', '/projects/p1/queue')).toBe('queue');
  });

  test('the project entry is labelled Work and keeps the board id and href', () => {
    const entry = visibleNav('viewer', '/projects/p1/board')
      .flatMap((section) => section.entries)
      .find((e) => e.id === 'board');
    expect(entry?.label).toBe('Work');
    expect(entry?.resolvedHref).toBe('/projects/p1/board');
  });

  test('Work, the project Planner and the admin Planner each light one entry', () => {
    expect(activeAt('viewer', '/work')).toBe('work');
    expect(activeAt('viewer', '/projects/p1/planner')).toBe('planner');
    expect(activeAt('viewer', '/projects/p1/planner/plan1')).toBe('planner');
    expect(activeAt('admin', '/admin/planner')).toBe('admin-planner');
  });

  test('Workflows lights its own entry, never Usage', () => {
    expect(activeAt('viewer', '/workflows')).toBe('workflows');
  });

  test('a session detail lights Sessions; a page outside the rail lights nothing', () => {
    expect(activeAt('viewer', '/sessions/s1')).toBe('sessions');
    expect(activeAt('viewer', '/account')).toBeNull();
  });

  test('exactly one entry matches on every page of the rail', () => {
    const path = '/projects/p1/queue';
    const sections = visibleNav('admin', path);
    const id = activeEntryId(sections, path);
    const marked = sections
      .flatMap((section) => section.entries)
      .filter((entry) => entry.id === id);
    expect(marked).toHaveLength(1);
  });
});

describe('tabBarSplit', () => {
  const split = (role: 'admin' | 'viewer', path: string) => {
    const { tabs, more } = tabBarSplit(visibleNav(role, path));
    return {
      tabs: tabs.map((entry) => entry.label),
      more: more.map(
        (section) =>
          `${section.id}: ${section.entries.map((e) => e.label).join(', ')}`,
      ),
    };
  };

  test('outside a project: the workspace five, the rest behind More', () => {
    expect(split('admin', '/')).toEqual({
      tabs: ['Overview', 'Projects', 'Activity', 'Sessions', 'Usage'],
      more: [
        'workspace: Work, Workflows, Skills',
        'admin: Runners, Users, Schedules, Budgets, Planner instructions, Audit, Prices, Integrations, Settings',
      ],
    });
  });

  test('inside a project: its working pages with Planner, Activity first in More', () => {
    expect(split('admin', '/projects/p1/queue')).toEqual({
      tabs: ['Fleet', 'Planner', 'Work', 'Queue', 'Approvals'],
      more: [
        'project: Activity, History, Skills, Schedules, Settings',
        'workspace: Overview, Projects, Activity, Work, Sessions, Usage, Workflows, Skills',
        'admin: Runners, Users, Schedules, Budgets, Planner instructions, Audit, Prices, Integrations, Settings',
      ],
    });
  });

  test('a viewer gets five tabs and no Admin; Work and Workflows wait behind More', () => {
    const { tabs, more } = split('viewer', '/');
    expect(tabs).toHaveLength(5);
    expect(more).toEqual(['workspace: Work, Workflows']);
  });

  test('tabs resolve the project id', () => {
    const { tabs } = tabBarSplit(visibleNav('viewer', '/projects/p1'));
    expect(tabs[0]?.resolvedHref).toBe('/projects/p1/fleet');
  });
});

describe('isWideEntry', () => {
  const wideAt = (path: string) => {
    const sections = visibleNav('admin', path);
    return isWideEntry(sections, activeEntryId(sections, path));
  };

  test('data pages and the pages below them take the wide column', () => {
    expect(wideAt('/sessions')).toBe(true);
    expect(wideAt('/projects/p1/history')).toBe(true);
    expect(wideAt('/projects/p1/history/r1')).toBe(true);
    expect(wideAt('/projects/p1/board')).toBe(true);
    expect(wideAt('/admin/audit')).toBe(true);
  });

  test('dashboards, forms and pages off the nav keep the reading column', () => {
    expect(wideAt('/')).toBe(false);
    expect(wideAt('/projects/p1/planner')).toBe(false);
    expect(wideAt('/projects/p1/settings')).toBe(false);
    expect(wideAt('/account')).toBe(false);
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

  test('an exact entry does not match the pages below it', () => {
    expect(isActive('/projects', '/projects/p1', true)).toBe(false);
    expect(isActive('/projects', '/projects', true)).toBe(true);
  });
});
