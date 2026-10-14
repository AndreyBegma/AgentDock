import type {
  PlanSummary,
  ProjectSummary,
  Role,
  RunSummary,
  SessionSummary,
} from '@agentdock/shared';
import type { CommandPaletteGroup } from '@andrewbehma/glass-ui/command-palette';
import {
  FolderGit2,
  Lightbulb,
  LogOut,
  type LucideIcon,
  Palette,
  Play,
  SquareTerminal,
  User,
} from 'lucide-react';
import { planHref } from '../../lib/planner/href';
import { planLabel, runLabel, sessionLabel } from './crumbs';
import { type VisibleSection, visibleNav } from './nav';

/** What the palette opened with: the newest sessions and the current project's runs. */
export interface RecentEntities {
  sessions: readonly SessionSummary[];
  runs: readonly RunSummary[];
}

export interface PaletteInput {
  query: string;
  role: Role;
  /** The rail's sections at the current path. */
  sections: readonly VisibleSection[];
  projects: readonly ProjectSummary[];
  projectId: string | null;
  recent: RecentEntities;
  /** The current project's plans; none outside a project. */
  plans: readonly PlanSummary[];
  /** The theme the "Switch theme" action reads as its hint. */
  themeLabel: string;
}

/** Project pages listed for a query: every project times eight pages adds up. */
const PROJECT_PAGES_MAX = 12;

/** Plans listed: the newest, or the newest that match the query. */
const PLANS_MAX = 5;

/** Every word of the query appears in the text, in any order. */
function matcher(query: string): (text: string) => boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return (text) => {
    const haystack = text.toLowerCase();
    return words.every((word) => haystack.includes(word));
  };
}

interface Item {
  id: string;
  label: string;
  hint?: string;
  icon?: LucideIcon;
}

function group(id: string, title: string, items: Item[]) {
  return items.length > 0 ? [{ id, title, items }] : [];
}

/** The project's own pages, labelled "AgentDock › Fleet". */
function projectPages(project: ProjectSummary, role: Role): Item[] {
  const section = visibleNav(role, `/projects/${project.id}`).find(
    (candidate) => candidate.id === 'project',
  );
  return (section?.entries ?? []).map((entry) => ({
    id: `go:${entry.resolvedHref}`,
    label: `${project.displayName} › ${entry.label}`,
    icon: entry.icon,
  }));
}

/**
 * The command palette's results (#159). Group titles are unique and no row
 * repeats its group's title as a hint. With no query, the project pages are
 * the current project's; with one, every project's that match.
 */
export function paletteGroups(input: PaletteInput): CommandPaletteGroup[] {
  const matches = matcher(input.query);
  const searching = input.query.trim() !== '';

  // The Admin pages share names with project pages (Settings, Schedules):
  // their own group tells them apart, once, instead of a hint on every row.
  const sectionPages = (id: VisibleSection['id']): Item[] =>
    input.sections
      .filter((section) => section.id === id)
      .flatMap((section) =>
        section.entries
          .filter((entry) => matches(`${section.title} ${entry.label}`))
          .map((entry) => ({
            id: `go:${entry.resolvedHref}`,
            label: entry.label,
            icon: entry.icon,
          })),
      );
  const pages = sectionPages('workspace');
  const admin = sectionPages('admin');
  if (matches('account')) {
    pages.push({ id: 'go:/account', label: 'Account', icon: User });
  }

  const current = input.projects.find(
    (project) => project.id === input.projectId,
  );
  const pagesOf = searching
    ? input.projects
    : current
      ? [current]
      : ([] as ProjectSummary[]);
  const subPages = pagesOf
    .flatMap((project) => projectPages(project, input.role))
    .filter((item) => matches(item.label))
    .slice(0, PROJECT_PAGES_MAX);

  const projects: Item[] = input.projects
    .filter((project) =>
      matches(`project ${project.displayName} ${project.repo}`),
    )
    .map((project) => ({
      id: `go:/projects/${project.id}`,
      label: project.displayName,
      hint: project.repo,
      icon: FolderGit2,
    }));

  const projectName = new Map(
    input.projects.map((project) => [project.id, project.displayName]),
  );
  const recent: Item[] = [
    ...input.recent.sessions.map((session) => ({
      id: `go:/sessions/${session.id}`,
      label: sessionLabel(session),
      hint: ['Session', session.projectName].filter(Boolean).join(' · '),
      icon: SquareTerminal,
    })),
    ...input.recent.runs.map((run) => ({
      id: `go:/projects/${run.projectId}/history/${run.id}`,
      label: runLabel(run),
      hint: ['Run', projectName.get(run.projectId)].filter(Boolean).join(' · '),
      icon: Play,
    })),
  ].filter((item) => matches(`${item.label} ${item.hint}`));

  const plans: Item[] = [...input.plans]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((plan) => ({
      id: `go:${planHref(plan.projectId, plan.id)}`,
      label: planLabel(plan),
      icon: Lightbulb,
    }))
    .filter((item) => matches(`plan ${item.label}`))
    .slice(0, PLANS_MAX);

  const actions: Item[] = [
    {
      id: 'action:theme',
      label: 'Switch theme',
      hint: input.themeLabel,
      icon: Palette,
    },
    { id: 'action:logout', label: 'Log out', icon: LogOut },
  ].filter((item) => matches(item.label));

  return [
    ...group('pages', 'Go to', pages),
    ...group('project-pages', 'Project pages', subPages),
    ...group('projects', 'Projects', projects),
    ...group('plans', 'Plans', plans),
    ...group('recent', 'Recent', recent),
    ...group('admin', 'Admin', admin),
    ...group('actions', 'Actions', actions),
  ];
}
