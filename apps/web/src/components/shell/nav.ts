import type { Role } from '@agentdock/shared';
import {
  Activity,
  BarChart3,
  FolderGit2,
  GitMerge,
  History,
  LayoutDashboard,
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
  Wand2,
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
}

export interface NavSection {
  id: 'overview' | 'project' | 'sessions' | 'usage' | 'admin';
  title: string;
  /** Shown only under `/projects/[projectId]`. */
  projectScoped?: boolean;
  entries: NavEntry[];
}

export const NAV: NavSection[] = [
  {
    id: 'overview',
    title: 'Overview',
    entries: [
      {
        id: 'overview',
        href: '/',
        label: 'Overview',
        icon: LayoutDashboard,
        minRole: 'viewer',
        enabled: true,
      },
      {
        id: 'projects',
        href: '/projects',
        label: 'Projects',
        icon: FolderGit2,
        minRole: 'viewer',
        enabled: true,
      },
      {
        id: 'activity',
        href: '/activity',
        label: 'Activity',
        icon: Radio,
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
      {
        id: 'fleet',
        href: '/projects/:projectId/fleet',
        label: 'Fleet',
        icon: Workflow,
        minRole: 'viewer',
        enabled: true,
      },
      {
        id: 'queue',
        href: '/projects/:projectId/queue',
        label: 'Queue',
        icon: ListChecks,
        minRole: 'viewer',
        enabled: true,
      },
      {
        id: 'approvals',
        href: '/projects/:projectId/approvals',
        label: 'Approvals',
        icon: GitMerge,
        minRole: 'viewer',
        enabled: true,
      },
      {
        id: 'project-activity',
        href: '/projects/:projectId/activity',
        label: 'Activity',
        icon: Radio,
        minRole: 'viewer',
        enabled: true,
      },
      {
        id: 'history',
        href: '/projects/:projectId/history',
        label: 'History',
        icon: History,
        minRole: 'viewer',
        enabled: true,
      },
      {
        id: 'project-skills',
        href: '/projects/:projectId/skills',
        label: 'Skills',
        icon: Wand2,
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
    id: 'sessions',
    title: 'Sessions',
    entries: [
      {
        id: 'sessions',
        href: '/sessions',
        label: 'Sessions',
        icon: Activity,
        minRole: 'viewer',
        enabled: true,
      },
    ],
  },
  {
    id: 'usage',
    title: 'Usage',
    entries: [
      {
        id: 'usage',
        href: '/usage',
        label: 'Usage',
        icon: BarChart3,
        minRole: 'viewer',
        enabled: true,
      },
    ],
  },
  {
    id: 'admin',
    title: 'Admin',
    entries: [
      {
        id: 'runners',
        href: '/admin/runners',
        label: 'Runners',
        icon: Server,
        minRole: 'admin',
        enabled: true,
      },
      {
        id: 'users',
        href: '/admin/users',
        label: 'Users',
        icon: Users,
        minRole: 'admin',
        enabled: true,
      },
      {
        id: 'audit',
        href: '/admin/audit',
        label: 'Audit',
        icon: ScrollText,
        minRole: 'admin',
        enabled: true,
      },
      {
        id: 'prices',
        href: '/admin/prices',
        label: 'Prices',
        icon: Tag,
        minRole: 'admin',
        enabled: true,
      },
      {
        id: 'integrations',
        href: '/admin/integrations/telegram',
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

export const isActive = (href: string, pathname: string): boolean =>
  href === '/'
    ? pathname === '/'
    : pathname === href || pathname.startsWith(`${href}/`);
