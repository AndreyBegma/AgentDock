import type { BreadcrumbItem } from '@andrewbehma/glass-ui/breadcrumb';
import { NAV } from './nav';

/**
 * Names the shell has resolved for the ids in the path: projects from the
 * project list, the run, plan or session of a detail page from its own GET. An id
 * missing here reads as its kind ("Run"), never as the id itself (#159 R2).
 */
export type CrumbNames = ReadonlyMap<string, string>;

/** Pages with a label of their own that the nav registry does not hold. */
const STATIC: Record<string, string> = {
  '/account': 'Account',
  '/account/notifications': 'Notifications',
  '/admin': 'Admin',
  '/admin/integrations/github': 'GitHub App',
  '/admin/integrations/github/callback': 'Connecting',
  '/admin/integrations/telegram': 'Telegram',
  '/admin/integrations/triggers': 'Triggers',
  '/admin/integrations/webhooks': 'Webhooks',
};

/** Paths in the trail that have no page of their own. */
const NO_PAGE = [/^\/admin$/, /^\/projects\/[^/]+\/skills\/runs$/];

const KNOWN: ReadonlyMap<string, string> = new Map([
  ...NAV.filter((section) => !section.projectScoped).flatMap((section) =>
    section.entries.map((entry) => [entry.href, entry.label] as const),
  ),
  ...Object.entries(STATIC),
]);

/** Project sub-page segment (`fleet`) → its nav label. */
const PROJECT_PAGES: ReadonlyMap<string, string> = new Map(
  NAV.filter((section) => section.projectScoped).flatMap((section) =>
    section.entries.map(
      (entry) => [entry.href.split('/').pop() ?? '', entry.label] as const,
    ),
  ),
);

/** A plain word is a page name; anything else (a cuid, a number) is an id. */
const isWord = (segment: string) => /^[a-z]+(-[a-z]+)*$/.test(segment);

const titleCase = (segment: string) =>
  segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, ' ');

/** What an id segment is, from the segment before it, for when its name is not known. */
function kindOf(segments: readonly string[], index: number): string {
  const parent = segments[index - 1];
  if (parent === 'projects' && index === 1) return 'Project';
  if (parent === 'sessions') return 'Session';
  if (parent === 'runs' && segments[index - 2] === 'skills') return 'Skill run';
  if (parent === 'history') return 'Run';
  if (parent === 'planner') return 'Plan';
  return 'Details';
}

function labelOf(
  segments: readonly string[],
  index: number,
  href: string,
  names: CrumbNames,
): string {
  const known = KNOWN.get(href);
  if (known) return known;
  const segment = segments[index] ?? '';
  const named = names.get(segment);
  if (named) return named;
  // `/projects/<id>/<page>`: the project's own pages.
  if (segments[0] === 'projects' && index === 2) {
    const page = PROJECT_PAGES.get(segment);
    if (page) return page;
  }
  if (segment === 'runs' && segments[index - 1] === 'skills') return 'Runs';
  // An id is never shown as text: the trail says what it is instead.
  if (index > 0 && !isWord(segment)) return kindOf(segments, index);
  return titleCase(segment);
}

/** The breadcrumb of `pathname`, labelled from the nav registry and from `names`. */
export function crumbsFor(
  pathname: string,
  names: CrumbNames = new Map(),
): BreadcrumbItem[] {
  if (pathname === '/') return [{ id: '/', label: 'Overview' }];
  const segments = pathname.split('/').filter(Boolean);
  return segments.map((_, index) => {
    const href = `/${segments.slice(0, index + 1).join('/')}`;
    const last = index === segments.length - 1;
    const noPage = NO_PAGE.some((pattern) => pattern.test(href));
    return {
      id: href,
      label: labelOf(segments, index, href, names),
      href: last || noPage ? undefined : href,
    };
  });
}

/** The product, the second half of every tab title outside a project. */
export const APP_NAME = 'AgentDock';

/**
 * The tab title for the trail (#213): `"<Page> · AgentDock"`, and inside a
 * project `"<Page> · <Project>"`, so two tabs on Fleet of two projects can be
 * told apart and a project named AgentDock does not read "AgentDock ·
 * AgentDock". `projectName` is the project's real name: until it is known the
 * project half falls back to the product rather than to the crumb's kind.
 */
export function pageTitleOf(
  crumbs: readonly BreadcrumbItem[],
  projectName?: string,
): string {
  const page = crumbs.at(-1)?.label;
  if (!page) return APP_NAME;
  const inProject = crumbs[0]?.id === '/projects' && crumbs.length > 2;
  return `${page} · ${inProject && projectName ? projectName : APP_NAME}`;
}

const MAX_LABEL = 48;

const clip = (text: string) =>
  text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text;

/** A run in the trail: `#155 · i155`, else its issue, title or slot. */
export function runLabel(run: {
  issue: number | null;
  slot: string | null;
  title: string | null;
}): string {
  if (run.issue !== null && run.slot) return `#${run.issue} · ${run.slot}`;
  if (run.issue !== null) return `#${run.issue}`;
  if (run.title) return clip(run.title);
  return run.slot ?? 'Run';
}

/** A plan in the trail and the palette: its title, else its kind. */
export function planLabel(plan: { title: string }): string {
  return plan.title.trim() ? clip(plan.title.trim()) : 'Plan';
}

/** A session in the trail: its title, else its slot. */
export function sessionLabel(session: {
  title: string | null;
  slotName: string | null;
}): string {
  if (session.title) return clip(session.title);
  return session.slotName ?? 'Session';
}
