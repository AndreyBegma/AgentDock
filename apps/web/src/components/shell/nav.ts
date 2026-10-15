import type { Role } from '@agentdock/shared';
import {
  Activity,
  BarChart3,
  CalendarClock,
  ChartColumn,
  FolderGit2,
  GitMerge,
  History,
  KanbanSquare,
  LayoutDashboard,
  Lightbulb,
  ListChecks,
  type LucideIcon,
  Plug,
  Radio,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  Tag,
  Users,
  Wallet,
  Wand2,
  Waypoints,
  Workflow,
} from 'lucide-react';

export interface NavEntry {
  id: string;
  /** `:projectId` is replaced with the current project's id. */
  href: string;
  label: string;
  icon: LucideIcon;
  /** Lowest role that sees the entry; the API stays the authority (spec D5). */
  minRole: Role;
  /** Flipped to `true` by the issue that builds the page (spec D4). */
  enabled: boolean;
  /**
   * Active only on `href` itself, never on a page below it: `/projects` is a
   * list, and inside a project the project's own entry is the active one.
   */
  exact?: boolean;
  /**
   * A data page (#213): the shell gives it the wide column (max-w-7xl), and
   * so every page below it (a run under History, a session under Sessions).
   */
  wide?: boolean;
}

export interface NavSection {
  id: 'workspace' | 'project' | 'admin';
  /** The project section is titled with the project's name by the shell. */
  title: string;
  /** Shown only under `/projects/[projectId]`. */
  projectScoped?: boolean;
  /** Folded into one expandable group unless one of its pages is open. */
  collapsible?: boolean;
  entries: NavEntry[];
}

export const NAV: NavSection[] = [
  {
    id: 'workspace',
    title: 'Workspace',
    entries: [
      {
        id: 'overview',
        href: '/',
        label: 'Overview',
        icon: LayoutDashboard,
        minRole: 'viewer',
        enabled: true,
        exact: true,
      },
      {
        id: 'projects',
        href: '/projects',
        label: 'Projects',
        icon: FolderGit2,
        minRole: 'viewer',
        enabled: true,
        exact: true,
      },
      {
        id: 'activity',
        wide: true,
        href: '/activity',
        label: 'Activity',
        icon: Radio,
        minRole: 'viewer',
        enabled: true,
      },
      {
        id: 'work',
        wide: true,
        href: '/work',
        label: 'Work',
        icon: KanbanSquare,
        minRole: 'viewer',
        enabled: true,
      },
      {
        id: 'sessions',
        wide: true,
        href: '/sessions',
        label: 'Sessions',
        icon: Activity,
        minRole: 'viewer',
        enabled: true,
      },
      {
        id: 'usage',
        wide: true,
        href: '/usage',
        label: 'Usage',
        icon: BarChart3,
        minRole: 'viewer',
        enabled: true,
      },
      {
        id: 'workflows',
        wide: true,
        href: '/workflows',
        label: 'Workflows',
        icon: Waypoints,
        minRole: 'viewer',
        enabled: true,
      },
      {
        id: 'skills-catalog',
        href: '/skills',
        label: 'Skills',
        icon: Sparkles,
        minRole: 'operator',
        enabled: true,
      },
    ],
  },
  {
    id: 'project',
    title: 'Project',
    projectScoped: true,
    entries: [
      // The project's home (card C-6): its figures, then the orchestrator.
      {
        id: 'project-home',
        wide: true,
        href: '/projects/:projectId',
        label: 'Project',
        icon: ChartColumn,
        minRole: 'viewer',
        enabled: true,
        exact: true,
      },
      {
        id: 'fleet',
        wide: true,
        href: '/projects/:projectId/fleet',
        label: 'Fleet',
        icon: Workflow,
        minRole: 'viewer',
        enabled: true,
      },
      // #337 D11: no Planner entry — New Card and New Plan live on the Board;
      // `/projects/:id/planner` stays reachable, read-only, off the nav.
      {
        id: 'board',
        wide: true,
        href: '/projects/:projectId/board',
        label: 'Work',
        icon: KanbanSquare,
        minRole: 'viewer',
        enabled: true,
      },
      {
        id: 'queue',
        wide: true,
        href: '/projects/:projectId/queue',
        label: 'Queue',
        icon: ListChecks,
        minRole: 'viewer',
        enabled: true,
      },
      {
        id: 'approvals',
        wide: true,
        href: '/projects/:projectId/approvals',
        label: 'Approvals',
        icon: GitMerge,
        minRole: 'viewer',
        enabled: true,
      },
      {
        id: 'project-activity',
        wide: true,
        href: '/projects/:projectId/activity',
        label: 'Activity',
        icon: Radio,
        minRole: 'viewer',
        enabled: true,
      },
      {
        id: 'history',
        wide: true,
        href: '/projects/:projectId/history',
        label: 'History',
        icon: History,
        minRole: 'viewer',
        enabled: true,
      },
      {
        id: 'project-skills',
        wide: true,
        href: '/projects/:projectId/skills',
        label: 'Skills',
        icon: Wand2,
        minRole: 'viewer',
        enabled: true,
      },
      {
        id: 'project-schedules',
        wide: true,
        href: '/projects/:projectId/schedules',
        label: 'Schedules',
        icon: CalendarClock,
        minRole: 'viewer',
        enabled: true,
      },
      {
        id: 'project-settings',
        href: '/projects/:projectId/settings',
        label: 'Settings',
        icon: Settings,
        minRole: 'viewer',
        enabled: true,
      },
    ],
  },
  {
    id: 'admin',
    title: 'Admin',
    collapsible: true,
    entries: [
      {
        id: 'runners',
        wide: true,
        href: '/admin/runners',
        label: 'Runners',
        icon: Server,
        minRole: 'admin',
        enabled: true,
      },
      {
        id: 'users',
        wide: true,
        href: '/admin/users',
        label: 'Users',
        icon: Users,
        minRole: 'admin',
        enabled: true,
      },
      {
        id: 'admin-schedules',
        wide: true,
        href: '/admin/schedules',
        label: 'Schedules',
        icon: CalendarClock,
        minRole: 'admin',
        enabled: true,
      },
      {
        id: 'admin-budgets',
        wide: true,
        href: '/admin/budgets',
        label: 'Budgets',
        icon: Wallet,
        minRole: 'admin',
        enabled: true,
      },
      {
        id: 'admin-planner',
        href: '/admin/planner',
        label: 'Planner instructions',
        icon: Lightbulb,
        minRole: 'admin',
        enabled: true,
      },
      {
        id: 'audit',
        wide: true,
        href: '/admin/audit',
        label: 'Audit',
        icon: ScrollText,
        minRole: 'admin',
        enabled: true,
      },
      {
        id: 'prices',
        wide: true,
        href: '/admin/prices',
        label: 'Prices',
        icon: Tag,
        minRole: 'admin',
        enabled: true,
      },
      // The hub: GitHub App, Telegram, webhooks and triggers are its pages.
      {
        id: 'integrations',
        href: '/admin/integrations',
        label: 'Integrations',
        icon: Plug,
        minRole: 'admin',
        enabled: true,
      },
      {
        id: 'admin-settings',
        href: '/admin/settings',
        label: 'Settings',
        icon: ShieldCheck,
        minRole: 'admin',
        enabled: true,
      },
    ],
  },
];

const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

export const canSee = (role: Role, minRole: Role): boolean =>
  RANK[role] >= RANK[minRole];

/** `/projects/<id>/…` → `<id>`; null anywhere else. */
export function projectIdOf(pathname: string): string | null {
  return /^\/projects\/([^/]+)/.exec(pathname)?.[1] ?? null;
}

export interface VisibleEntry extends NavEntry {
  /** `href` with the project id filled in. */
  resolvedHref: string;
}

export interface VisibleSection extends Omit<NavSection, 'entries'> {
  entries: VisibleEntry[];
}

/** What `role` may see at `pathname`: enabled entries, project section only inside a project. */
export function visibleNav(role: Role, pathname: string): VisibleSection[] {
  const projectId = projectIdOf(pathname);
  const sections: VisibleSection[] = [];
  for (const section of NAV) {
    if (section.projectScoped && !projectId) continue;
    const entries = section.entries
      .filter((entry) => entry.enabled && canSee(role, entry.minRole))
      .map((entry) => ({
        ...entry,
        resolvedHref: projectId
          ? entry.href.replace(':projectId', projectId)
          : entry.href,
      }));
    if (entries.length > 0) sections.push({ ...section, entries });
  }
  return sections;
}

/**
 * The phone's tab bar (#163): five places, the rest behind More. Outside a
 * project the workspace's five; inside one, the project's home and its
 * working pages — the project's Activity behind More (#213, C-6).
 */
const TAB_IDS = {
  workspace: ['overview', 'projects', 'activity', 'sessions', 'usage'],
  project: ['project-home', 'fleet', 'board', 'queue', 'approvals'],
} as const;

export interface TabBarSplit {
  /** In bar order; only entries the role can see. */
  tabs: VisibleEntry[];
  /** Everything else, by section, the current project's first. */
  more: VisibleSection[];
}

export function tabBarSplit(sections: readonly VisibleSection[]): TabBarSplit {
  const inProject = sections.some((section) => section.id === 'project');
  const ids: readonly string[] = TAB_IDS[inProject ? 'project' : 'workspace'];
  const entries = sections.flatMap((section) => section.entries);
  const tabs = ids.flatMap((id) => entries.filter((entry) => entry.id === id));
  const rest = sections
    .map((section) => ({
      ...section,
      entries: section.entries.filter((entry) => !ids.includes(entry.id)),
    }))
    .filter((section) => section.entries.length > 0);
  const more = [
    ...rest.filter((section) => section.id === 'project'),
    ...rest.filter((section) => section.id !== 'project'),
  ];
  return { tabs, more };
}

export const isActive = (
  href: string,
  pathname: string,
  exact = href === '/',
): boolean => pathname === href || (!exact && pathname.startsWith(`${href}/`));

/**
 * The one entry to mark active at `pathname`: of those that match, the one
 * with the longest href, so a page below two entries lights only the closer.
 * Null when no entry matches (`/account`).
 */
export function activeEntryId(
  sections: readonly VisibleSection[],
  pathname: string,
): string | null {
  let best: VisibleEntry | null = null;
  for (const section of sections) {
    for (const entry of section.entries) {
      if (!isActive(entry.resolvedHref, pathname, entry.exact)) continue;
      if (!best || entry.resolvedHref.length > best.resolvedHref.length) {
        best = entry;
      }
    }
  }
  return best?.id ?? null;
}

/** Whether the page at the active entry takes the wide column; false off the nav. */
export function isWideEntry(
  sections: readonly VisibleSection[],
  activeId: string | null,
): boolean {
  if (!activeId) return false;
  return sections.some((section) =>
    section.entries.some((entry) => entry.id === activeId && entry.wide),
  );
}
