import type { Role } from '@agentdock/shared';
import {
  Activity,
  BarChart3,
  BrainCircuit,
  CalendarClock,
  ChartColumn,
  FolderGit2,
  Gauge,
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
   * so every page below it (a skill run under Skills, a session under Sessions).
   */
  wide?: boolean;
  /**
   * A page that fills the screen (C-29): the shell locks to the viewport, the
   * page drops the width cap and scrolls its own regions, not the window.
   */
  fill?: boolean;
  /**
   * Stays in view (C-247, C-282): a section shows its primary entries and
   * folds the others into its More group — on the open rail a group of its
   * own, on the icon rail and the phone's capsule one More sheet. The capsule
   * holds a subset of them (`TAB_IDS`).
   */
  primary?: boolean;
  /**
   * The one entry the product is built around, the Board (C-282): drawn in
   * glass-ui's primary-entry frame (`NavRailItem.primary`). One per rail.
   */
  main?: boolean;
}

export interface NavSection {
  id: 'workspace' | 'project' | 'admin';
  /** The project section is titled with the project's name by the shell. */
  title: string;
  /** Shown only under `/projects/[projectId]`. */
  projectScoped?: boolean;
  /**
   * Opened from the account menu (C-282): its pages carry their own
   * sub-navigation, and it stays out of the rail and the capsule. The palette
   * and the breadcrumbs still read it.
   */
  accountMenu?: boolean;
  entries: NavEntry[];
}

export const NAV: NavSection[] = [
  {
    id: 'workspace',
    title: 'Workspace',
    entries: [
      {
        id: 'overview',
        primary: true,
        href: '/',
        label: 'Overview',
        icon: LayoutDashboard,
        minRole: 'viewer',
        enabled: true,
        exact: true,
      },
      {
        id: 'projects',
        primary: true,
        href: '/projects',
        label: 'Projects',
        icon: FolderGit2,
        minRole: 'viewer',
        enabled: true,
        exact: true,
      },
      {
        id: 'work',
        primary: true,
        wide: true,
        href: '/work',
        label: 'Work',
        icon: KanbanSquare,
        minRole: 'viewer',
        enabled: true,
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
    // C-282: five in view, the Board first; the rest under More. Activity
    // absorbed History as its Runs tab (C-285); Queue absorbs Approvals as a
    // tab (C-284).
    entries: [
      {
        id: 'board',
        primary: true,
        main: true,
        wide: true,
        fill: true,
        href: '/projects/:projectId/board',
        label: 'Board',
        icon: KanbanSquare,
        minRole: 'viewer',
        enabled: true,
      },
      {
        id: 'fleet',
        primary: true,
        wide: true,
        href: '/projects/:projectId/fleet',
        label: 'Fleet',
        icon: Workflow,
        minRole: 'viewer',
        enabled: true,
      },
      {
        id: 'queue',
        primary: true,
        wide: true,
        href: '/projects/:projectId/queue',
        label: 'Queue',
        icon: ListChecks,
        minRole: 'viewer',
        enabled: true,
      },
      {
        id: 'project-activity',
        primary: true,
        wide: true,
        href: '/projects/:projectId/activity',
        label: 'Activity',
        icon: Radio,
        minRole: 'viewer',
        enabled: true,
      },
      {
        id: 'project-settings',
        primary: true,
        href: '/projects/:projectId/settings',
        label: 'Settings',
        icon: Settings,
        minRole: 'viewer',
        enabled: true,
      },
      // The project's home (card C-6): its figures, then the orchestrator.
      {
        id: 'project-home',
        wide: true,
        href: '/projects/:projectId',
        label: 'Project home',
        icon: ChartColumn,
        minRole: 'viewer',
        enabled: true,
        exact: true,
      },
      // #337 D11 took the Planner off the nav (New work lives on the Board);
      // C-282 brings its read-only pages back under More.
      {
        id: 'planner',
        href: '/projects/:projectId/planner',
        label: 'Planner',
        icon: Lightbulb,
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
        id: 'project-skills',
        wide: true,
        href: '/projects/:projectId/skills',
        label: 'Skills',
        icon: Wand2,
        minRole: 'viewer',
        enabled: true,
      },
      // #445 D13: what Token saver kept out of what this project's agents read.
      {
        id: 'project-token-saver',
        wide: true,
        href: '/projects/:projectId/token-saver',
        label: 'Token saver',
        icon: Gauge,
        minRole: 'viewer',
        enabled: true,
      },
    ],
  },
  {
    id: 'admin',
    title: 'Admin',
    accountMenu: true,
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
        id: 'ai-providers',
        wide: true,
        href: '/admin/ai-providers',
        label: 'AI providers',
        icon: BrainCircuit,
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

/** The sections the rail and the capsule draw: Admin opens from the account menu. */
const inNav = (sections: readonly VisibleSection[]): VisibleSection[] =>
  sections.filter((section) => !section.accountMenu);

/** One block of the open rail: a section, or a section's More. */
export interface RailGroupSpec {
  id: 'workspace' | 'workspace-more' | 'project' | 'project-more';
  title: string;
  entries: VisibleEntry[];
  /** The heading folds the entries; the rail unfolds it for the active page. */
  collapsible: boolean;
}

const MORE_ID = {
  workspace: 'workspace-more',
  project: 'project-more',
} as const;

/**
 * The open rail's blocks (C-247, C-282): each section keeps its `primary`
 * entries in view and the rest go to a folding "More" group right under it.
 * A section that marks none (or only primary ones) is drawn whole. Admin is
 * not in the rail.
 */
export function railGroups(
  sections: readonly VisibleSection[],
): RailGroupSpec[] {
  const groups: RailGroupSpec[] = [];
  for (const section of inNav(sections)) {
    if (section.id === 'admin') continue;
    const primary = section.entries.filter((entry) => entry.primary);
    const rest = section.entries.filter((entry) => !entry.primary);
    const whole = rest.length === 0 || primary.length === 0;
    groups.push({
      id: section.id,
      title: section.title,
      entries: whole ? section.entries : primary,
      collapsible: false,
    });
    if (whole) continue;
    groups.push({
      id: MORE_ID[section.id],
      title: 'More',
      entries: rest,
      collapsible: true,
    });
  }
  return groups;
}

export interface NavSplit {
  /** In view, by section; only entries the role can see. */
  shown: VisibleSection[];
  /** Behind More, by section, the current project's first. */
  more: VisibleSection[];
}

/** `sections` split on `keep`; the project leads More, as the page in hand. */
function splitBy(
  sections: readonly VisibleSection[],
  keep: (entry: VisibleEntry, section: VisibleSection) => boolean,
): NavSplit {
  const visible = inNav(sections);
  const pick = (inView: boolean) =>
    visible
      .map((section) => ({
        ...section,
        entries: section.entries.filter(
          (entry) => keep(entry, section) === inView,
        ),
      }))
      .filter((section) => section.entries.length > 0);
  const more = pick(false);
  return {
    shown: pick(true),
    more: [
      ...more.filter((section) => section.id === 'project'),
      ...more.filter((section) => section.id !== 'project'),
    ],
  };
}

/** Whether a section shows `entry` in view: its primary ones, or all when it marks none. */
const isPrimaryIn = (entry: VisibleEntry, section: VisibleSection) =>
  !!entry.primary || !section.entries.some((each) => each.primary);

/**
 * The rail folded to icons — a tablet, or the desktop rail collapsed (C-14):
 * each section's primary entries, everything else behind one More (C-282).
 */
export const iconRailSplit = (sections: readonly VisibleSection[]): NavSplit =>
  splitBy(sections, isPrimaryIn);

/**
 * The phone's capsule (#163, #521, C-282): three places, the rest behind More.
 * Outside a project the workspace's primary three; inside one the Board,
 * Queue and Activity — a subset of the project's primary five, which a phone's
 * width cannot hold beside More and the `+`.
 */
const TAB_IDS = {
  workspace: ['overview', 'projects', 'work'],
  project: ['board', 'queue', 'project-activity'],
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
  const { more } = splitBy(sections, (entry) => ids.includes(entry.id));
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

/**
 * Whether the page itself — not a page below it, a card's design under Board —
 * is the active entry and fills the screen; false off the nav.
 */
export function isFillEntry(
  sections: readonly VisibleSection[],
  activeId: string | null,
  pathname: string,
): boolean {
  if (!activeId) return false;
  const path = pathname.replace(/\/+$/, '');
  return sections.some((section) =>
    section.entries.some(
      (entry) =>
        entry.id === activeId && entry.fill && entry.resolvedHref === path,
    ),
  );
}
