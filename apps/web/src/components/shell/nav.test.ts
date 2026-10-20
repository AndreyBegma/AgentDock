import { describe, expect, test } from 'bun:test';
import {
  activeEntryId,
  iconRailSplit,
  isActive,
  isFillEntry,
  isWideEntry,
  projectIdOf,
  railGroups,
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
      'workspace/Work',
      'workspace/Activity',
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
      'admin/AI providers',
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
      'workspace/Work',
      'workspace/Activity',
      'workspace/Sessions',
      'workspace/Usage',
      'workspace/Workflows',
    ]);
    expect(labels('viewer', '/').join()).not.toContain('Tasks');
    const inProject = labels('viewer', '/projects/p1/settings');
    for (const page of [
      'Project home',
      'Fleet',
      'Board',
      'Queue',
      'Activity',
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
    expect(activeAt('admin', '/projects/p1/activity')).toBe('project-activity');
    expect(activeAt('admin', '/projects/p1/skills/runs/r1')).toBe(
      'project-skills',
    );
  });

  test('/projects is active only on the list itself', () => {
    expect(activeAt('viewer', '/projects')).toBe('projects');
    expect(activeAt('viewer', '/projects/p1')).toBe('project-home');
  });

  test('the project home lights only on itself, never under a sub-page', () => {
    expect(activeAt('viewer', '/projects/p1/fleet')).toBe('fleet');
    expect(activeAt('viewer', '/projects/p1/queue')).toBe('queue');
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

  test('the project Board entry lights its own entry, not the Queue', () => {
    expect(activeAt('viewer', '/projects/p1/board')).toBe('board');
    expect(activeAt('viewer', '/projects/p1/queue')).toBe('queue');
  });

  test('the project Board is labelled Board, first and the main entry (C-282)', () => {
    const project = visibleNav('viewer', '/projects/p1/board').find(
      (section) => section.id === 'project',
    );
    const entry = project?.entries[0];
    expect(entry?.id).toBe('board');
    expect(entry?.label).toBe('Board');
    expect(entry?.main).toBe(true);
    expect(entry?.resolvedHref).toBe('/projects/p1/board');
    expect(project?.entries.filter((e) => e.main)).toHaveLength(1);
  });

  test('Work and the admin Planner each light one entry', () => {
    expect(activeAt('viewer', '/work')).toBe('work');
    expect(activeAt('admin', '/admin/planner')).toBe('admin-planner');
  });

  test('the Planner is back under the project More, and lights on its pages (C-282)', () => {
    expect(labels('admin', '/projects/p1/board')).toContain('project/Planner');
    expect(activeAt('viewer', '/projects/p1/planner')).toBe('planner');
    expect(activeAt('viewer', '/projects/p1/planner/plan1')).toBe('planner');
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

  test('outside a project: the workspace three, the rest behind More', () => {
    expect(split('admin', '/')).toEqual({
      tabs: ['Overview', 'Projects', 'Work'],
      more: ['workspace: Activity, Sessions, Usage, Workflows, Skills'],
    });
  });

  test('inside a project: Board, Queue and Activity; the project first in More (C-282)', () => {
    expect(split('admin', '/projects/p1/queue')).toEqual({
      tabs: ['Board', 'Queue', 'Activity'],
      more: [
        'project: Fleet, Settings, Project home, Planner, Schedules, Skills, Token saver',
        'workspace: Overview, Projects, Work, Activity, Sessions, Usage, Workflows, Skills',
      ],
    });
  });

  test('Admin is never in the capsule or its More: it is in the account menu', () => {
    const { tabs, more } = split('admin', '/admin/users');
    expect(tabs.join()).not.toContain('Runners');
    expect(more.join()).not.toContain('admin');
  });

  test('a viewer gets three tabs and no Admin; the rest waits behind More', () => {
    const { tabs, more } = split('viewer', '/');
    expect(tabs).toHaveLength(3);
    expect(more).toEqual(['workspace: Activity, Sessions, Usage, Workflows']);
  });

  test('tabs resolve the project id', () => {
    const { tabs } = tabBarSplit(visibleNav('viewer', '/projects/p1'));
    expect(tabs[0]?.resolvedHref).toBe('/projects/p1/board');
  });
});

describe('isWideEntry', () => {
  const wideAt = (path: string) => {
    const sections = visibleNav('admin', path);
    return isWideEntry(sections, activeEntryId(sections, path));
  };

  test('data pages and the pages below them take the wide column', () => {
    expect(wideAt('/sessions')).toBe(true);
    expect(wideAt('/projects/p1/activity')).toBe(true);
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

describe('isFillEntry', () => {
  const fillAt = (path: string) => {
    const sections = visibleNav('admin', path);
    return isFillEntry(sections, activeEntryId(sections, path), path);
  };

  test('the board fills the screen; the pages below it and the others do not', () => {
    expect(fillAt('/projects/p1/board')).toBe(true);
    expect(fillAt('/projects/p1/board/')).toBe(true);
    expect(fillAt('/projects/p1/board/cards/3/design')).toBe(false);
    expect(fillAt('/projects/p1/fleet')).toBe(false);
  });
});

describe('railGroups (C-247)', () => {
  const groups = (role: 'admin' | 'viewer', path: string) =>
    railGroups(visibleNav(role, path)).map((group) => ({
      id: group.id,
      collapsible: group.collapsible,
      entries: group.entries.map((entry) => entry.label),
    }));

  test('inside a project five entries stay in view, the Board first (C-282)', () => {
    const [, , project, more] = groups('viewer', '/projects/p1/fleet');
    expect(project).toEqual({
      id: 'project',
      collapsible: false,
      entries: ['Board', 'Fleet', 'Queue', 'Activity', 'Settings'],
    });
    expect(more).toEqual({
      id: 'project-more',
      collapsible: true,
      entries: [
        'Project home',
        'Planner',
        'Schedules',
        'Skills',
        'Token saver',
      ],
    });
  });

  test('Workspace keeps Overview, Projects and Work; each More folds; no Admin', () => {
    expect(
      groups('admin', '/projects/p1').map((g) => [g.id, g.collapsible]),
    ).toEqual([
      ['workspace', false],
      ['workspace-more', true],
      ['project', false],
      ['project-more', true],
    ]);
    expect(groups('admin', '/')[0]?.entries).toEqual([
      'Overview',
      'Projects',
      'Work',
    ]);
  });

  test('a viewer gets no Admin group and no operator-only Workspace entry', () => {
    const all = groups('viewer', '/projects/p1');
    expect(all.map((g) => g.id)).not.toContain('admin');
    expect(all.flatMap((g) => g.entries)).not.toContain('Skills catalog');
    expect(all[1]?.entries).not.toContain('Skills');
  });

  test('every entry but the Admin pages stays in exactly one group', () => {
    const sections = visibleNav('admin', '/projects/p1');
    const ids = railGroups(sections).flatMap((g) => g.entries.map((e) => e.id));
    expect(ids.sort()).toEqual(
      sections
        .filter((s) => s.id !== 'admin')
        .flatMap((s) => s.entries.map((e) => e.id))
        .sort(),
    );
  });
});

describe('iconRailSplit (C-282)', () => {
  const split = (path: string) => {
    const { shown, more } = iconRailSplit(visibleNav('admin', path));
    const draw = (sections: typeof shown) =>
      sections.map(
        (section) =>
          `${section.id}: ${section.entries.map((e) => e.label).join(', ')}`,
      );
    return { shown: draw(shown), more: draw(more) };
  };

  test('a tablet shows the primary entries and puts the rest behind More', () => {
    expect(split('/projects/p1/board')).toEqual({
      shown: [
        'workspace: Overview, Projects, Work',
        'project: Board, Fleet, Queue, Activity, Settings',
      ],
      more: [
        'project: Project home, Planner, Schedules, Skills, Token saver',
        'workspace: Activity, Sessions, Usage, Workflows, Skills',
      ],
    });
  });

  test('every hidden entry is one More click away, Admin aside', () => {
    const sections = visibleNav('admin', '/projects/p1');
    const { shown, more } = iconRailSplit(sections);
    const ids = [...shown, ...more].flatMap((s) => s.entries.map((e) => e.id));
    expect(ids.sort()).toEqual(
      sections
        .filter((s) => s.id !== 'admin')
        .flatMap((s) => s.entries.map((e) => e.id))
        .sort(),
    );
  });
});
