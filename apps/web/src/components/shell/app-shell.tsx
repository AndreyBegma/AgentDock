'use client';

import {
  LIVE_CLOSE_CODES,
  type ProjectSummary,
  type PublicUser,
  type RunPage,
  type SessionListResponse,
} from '@agentdock/shared';
import { ActionList } from '@andrewbehma/glass-ui/action-list';
import { Avatar } from '@andrewbehma/glass-ui/avatar';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Breadcrumb } from '@andrewbehma/glass-ui/breadcrumb';
import { Button } from '@andrewbehma/glass-ui/button';
import { CommandPalette } from '@andrewbehma/glass-ui/command-palette';
import { KeyHint } from '@andrewbehma/glass-ui/key-hint';
import {
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from '@andrewbehma/glass-ui/menu';
import { TabBar, type TabBarProps } from '@andrewbehma/glass-ui/tab-bar';
import { toast } from '@andrewbehma/glass-ui/toast';
import { useCommandPaletteShortcut } from '@andrewbehma/glass-ui/use-command-palette-shortcut';
import { ArrowLeft, LogOut, Search, User } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { api, describeError } from '../../lib/api';
import { useLiveStatus } from '../../lib/live/use-live';
import { crumbsFor, pageTitleOf } from './crumbs';
import { liveDotLabel, useLivePaused } from './live-status';
import { activeEntryId, projectIdOf, tabBarSplit, visibleNav } from './nav';
import { NotificationBell } from './notification-bell';
import { paletteGroups, type RecentEntities } from './palette';
import { ProjectSwitcher } from './project-switcher';
import { Rail } from './rail';
import {
  applyTheme,
  isThemeMode,
  readStoredTheme,
  storeTheme,
  THEME_LABEL,
  THEME_MODES,
  type ThemeMode,
} from './theme';
import { useCrumbNames } from './use-crumb-names';
import { useSlotsNeedingAttention } from './use-slots-needing-attention';
import { useWaitingApprovals } from './use-waiting-approvals';
import { UserProvider } from './user-context';

const COLLAPSE_QUERY = '(max-width: 1023px)';

/** Rows the palette's Recent group lists per kind. */
const RECENT_LIMIT = 5;

const NO_RECENT: RecentEntities = { sessions: [], runs: [] };

/** The tab bar's and More's anchors are Next links. */
const renderLink: NonNullable<TabBarProps['link']> = ({
  href,
  className,
  children: content,
  ...rest
}) => (
  <Link href={href} className={className} {...rest}>
    {content}
  </Link>
);

function useNarrow(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const query = window.matchMedia(COLLAPSE_QUERY);
      query.addEventListener('change', listener);
      return () => query.removeEventListener('change', listener);
    },
    () => window.matchMedia(COLLAPSE_QUERY).matches,
    () => false,
  );
}

function useTheme(): [ThemeMode, (mode: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>('system');
  useEffect(() => setMode(readStoredTheme()), []);

  // Follow the OS while the mode is `system`.
  useEffect(() => {
    if (mode !== 'system') return;
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => applyTheme('system');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [mode]);

  const choose = useCallback((next: ThemeMode) => {
    setMode(next);
    storeTheme(next);
    applyTheme(next);
  }, []);
  return [mode, choose];
}

/** The projects the caller may see, fetched once for the rail, trail and palette. */
function useProjects(): ProjectSummary[] {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  useEffect(() => {
    let cancelled = false;
    api<ProjectSummary[]>('/projects')
      .then((list) => {
        if (!cancelled && Array.isArray(list)) setProjects(list);
      })
      .catch(() => {
        // No switcher and no project names; the Projects page still works.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return projects;
}

/** The newest sessions and the current project's runs, read when the palette opens. */
function useRecent(open: boolean, projectId: string | null): RecentEntities {
  const [recent, setRecent] = useState<RecentEntities>(NO_RECENT);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const sessions = api<SessionListResponse>(
      `/sessions?limit=${RECENT_LIMIT}`,
    ).then(
      (page) => page.items,
      () => [],
    );
    const runs = projectId
      ? api<RunPage>(`/projects/${projectId}/runs?limit=${RECENT_LIMIT}`).then(
          (page) => page.items,
          () => [],
        )
      : Promise.resolve([]);
    void Promise.all([sessions, runs]).then(([sessionItems, runItems]) => {
      if (!cancelled) setRecent({ sessions: sessionItems, runs: runItems });
    });
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);
  return recent;
}

/** The root layout's `title.default`: what a page without metadata gets. */
const DEFAULT_TITLE = 'AgentDock';

/**
 * Client pages have no metadata of their own, so the trail names the tab.
 * Next writes the metadata title after this effect (it streams), so the
 * default is replaced whenever it appears, and so is the title this hook set
 * for the previous page; a page that set its own `metadata.title` keeps it.
 */
function useDocumentTitle(title: string) {
  const ours = useRef<string | null>(null);
  useEffect(() => {
    const apply = () => {
      const current = document.title;
      if (current === title) return;
      if (current !== DEFAULT_TITLE && current !== ours.current) return;
      document.title = title;
      ours.current = title;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [title]);
}

function ConnectionDot({ status, paused }: ReturnType<typeof useLivePaused>) {
  const label = liveDotLabel(status, paused);
  const tone = status === 'connected' ? 'ok' : 'warn';
  return (
    <span className="inline-flex items-center gap-2" title={label}>
      <Badge dot tone={tone} aria-hidden="true" />
      <span className="sr-only" role="status">
        {label}
      </span>
    </span>
  );
}

export function AppShell({
  user,
  children,
}: {
  user: PublicUser;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const narrow = useNarrow();
  const [theme, setTheme] = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const projectId = projectIdOf(pathname);
  const projects = useProjects();
  const recent = useRecent(paletteOpen, projectId);
  const names = useCrumbNames(pathname, projects);

  useCommandPaletteShortcut(() => setPaletteOpen(true));

  // The bell holds the `user:<id>` subscription that keeps the socket (and the dot) alive.
  const { status, closeCode } = useLiveStatus();
  const live = useLivePaused();
  useEffect(() => {
    if (status === 'offline' && closeCode === LIVE_CLOSE_CODES.unauthorized) {
      router.replace('/login');
    }
  }, [status, closeCode, router]);

  const sections = useMemo(
    () => visibleNav(user.role, pathname),
    [user.role, pathname],
  );
  const activeId = activeEntryId(sections, pathname);

  const crumbs = useMemo(() => crumbsFor(pathname, names), [pathname, names]);
  const pageTitle = pageTitleOf(crumbs);
  useDocumentTitle(`${pageTitle} · AgentDock`);
  const parent = crumbs.length > 1 ? crumbs.at(-2) : undefined;

  // The rail's badges on Approvals and Fleet.
  const waitingApprovals = useWaitingApprovals(projectId);
  const slotsNeedingAttention = useSlotsNeedingAttention(projectId);

  // Below `lg`: five tabs, the rest in More's sheet, which a navigation closes.
  const { tabs, more } = useMemo(() => tabBarSplit(sections), [sections]);
  const [moreOpen, setMoreOpen] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger
  useEffect(() => setMoreOpen(false), [pathname]);
  const projectName = projects.find(
    (project) => project.id === projectId,
  )?.displayName;

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
      router.replace('/login');
    } catch (error) {
      toast.error(describeError(error));
    }
  }, [router]);

  const cycleTheme = () =>
    setTheme(
      THEME_MODES[(THEME_MODES.indexOf(theme) + 1) % THEME_MODES.length] ??
        'system',
    );

  const search = (query: string) =>
    paletteGroups({
      query,
      role: user.role,
      sections,
      projects,
      projectId,
      recent,
      themeLabel: THEME_LABEL[theme],
    });

  const onSelect = (item: { id: string }) => {
    setPaletteOpen(false);
    if (item.id.startsWith('go:')) router.push(item.id.slice(3));
    else if (item.id === 'action:theme') cycleTheme();
    else if (item.id === 'action:logout') void logout();
  };

  const displayName = user.name ?? user.email;

  return (
    <UserProvider value={user}>
      <a
        href="#main-content"
        className="glass-strong sr-only z-overlay rounded-control px-3 py-2 text-sm text-ink focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to content
      </a>
      <div
        className={`flex min-h-screen ${narrow ? 'gap-2 p-2' : 'gap-3 p-3'}`}
      >
        {narrow ? null : (
          <aside className="sticky top-3 h-[calc(100vh-1.5rem)] shrink-0">
            <Rail
              sections={sections}
              activeId={activeId}
              projects={projects}
              projectId={projectId}
              waitingApprovals={waitingApprovals}
              slotsNeedingAttention={slotsNeedingAttention}
            />
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <header
            className={`glass rounded-surface flex min-h-12 items-center py-2 ${narrow ? 'gap-0.5 px-2' : 'gap-3 px-4'}`}
          >
            {narrow ? (
              // A phone has no room for the trail: the page, and a way up.
              <div className="flex min-w-0 flex-1 items-center gap-1">
                {parent?.href ? (
                  <Link
                    href={parent.href}
                    aria-label={`Back to ${parent.label}`}
                    className="flex size-8 shrink-0 items-center justify-center rounded-control text-ink-2 hover:bg-hover hover:text-ink"
                  >
                    <ArrowLeft size={16} aria-hidden="true" />
                  </Link>
                ) : null}
                <span className="truncate text-section text-ink">
                  {crumbs.at(-1)?.label}
                </span>
              </div>
            ) : (
              <Breadcrumb
                items={crumbs}
                aria-label="Breadcrumb"
                overflowLabel="Show the path"
                className="min-w-0 flex-1"
                link={({ href, className, children: content, ...rest }) => (
                  <Link href={href} className={className} {...rest}>
                    {content}
                  </Link>
                )}
              />
            )}
            <span className={narrow ? 'px-1.5' : undefined}>
              <ConnectionDot {...live} />
            </span>
            <Button
              variant="ghost"
              size="sm"
              icon={narrow}
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
            >
              <Search size={14} aria-hidden="true" />
              {narrow ? null : <KeyHint keys="mod+k" />}
            </Button>
            <NotificationBell />
            <MenuRoot>
              <MenuTrigger asChild>
                <button
                  type="button"
                  className="rounded-full"
                  aria-label="Account menu"
                >
                  <Avatar size="sm" name={displayName} />
                </button>
              </MenuTrigger>
              <MenuContent align="end">
                <MenuLabel>
                  {displayName} · {user.role}
                </MenuLabel>
                <MenuItem onSelect={() => router.push('/account')}>
                  <User size={16} aria-hidden="true" />
                  Account
                </MenuItem>
                <MenuSeparator />
                <MenuLabel>Theme</MenuLabel>
                <MenuRadioGroup
                  value={theme}
                  onValueChange={(value) => {
                    if (isThemeMode(value)) setTheme(value);
                  }}
                >
                  {THEME_MODES.map((mode) => (
                    <MenuRadioItem key={mode} value={mode}>
                      {THEME_LABEL[mode]}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
                <MenuSeparator />
                <MenuItem tone="danger" onSelect={() => void logout()}>
                  <LogOut size={16} aria-hidden="true" />
                  Log out
                </MenuItem>
              </MenuContent>
            </MenuRoot>
          </header>

          {live.paused && closeCode !== LIVE_CLOSE_CODES.unauthorized ? (
            <Banner
              tone="warn"
              title="Live updates paused."
              action={
                <Button
                  variant="glass"
                  size="sm"
                  onClick={() => window.location.reload()}
                >
                  Reload
                </Button>
              }
            >
              This page may be out of date.
            </Banner>
          ) : null}

          <main
            id="main-content"
            tabIndex={-1}
            className="mx-auto w-full max-w-5xl pb-6 focus:outline-none"
          >
            {children}
          </main>

          {narrow ? (
            // Below `lg` the tab bar replaces the rail; its spacer keeps the
            // page's end clear of it.
            <TabBar
              aria-label="Main"
              items={tabs.map((entry) => ({
                id: entry.id,
                label: entry.label,
                icon: entry.icon,
                href: entry.resolvedHref,
                active: entry.id === activeId,
              }))}
              link={renderLink}
              more={
                more.length > 0
                  ? {
                      label: 'More',
                      title: 'More pages',
                      open: moreOpen,
                      onOpenChange: setMoreOpen,
                      children: (
                        <div className="flex flex-col gap-4">
                          <ProjectSwitcher
                            projects={projects}
                            projectId={projectId}
                          />
                          {more.map((section) => (
                            <ActionList
                              key={section.id}
                              surface="content"
                              heading={
                                section.id === 'project' && projectName
                                  ? projectName
                                  : section.title
                              }
                              link={renderLink}
                              items={section.entries.map((entry) => ({
                                id: entry.id,
                                label: entry.label,
                                icon: entry.icon,
                                href: entry.resolvedHref,
                              }))}
                            />
                          ))}
                        </div>
                      ),
                    }
                  : undefined
              }
            />
          ) : null}
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        search={search}
        onSelect={onSelect}
        placeholder="Go to a page, a project or a recent run"
      />
    </UserProvider>
  );
}
