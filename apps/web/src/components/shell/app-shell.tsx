'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Breadcrumb } from '@andrewbehma/glass-ui/breadcrumb';
import { Button } from '@andrewbehma/glass-ui/button';
import { CommandPalette } from '@andrewbehma/glass-ui/command-palette';
import { KeyHint } from '@andrewbehma/glass-ui/key-hint';
import { Separator } from '@andrewbehma/glass-ui/separator';
import { toast } from '@andrewbehma/glass-ui/toast';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import { useBreakpoint } from '@andrewbehma/glass-ui/use-breakpoint';
import { useCommandPaletteShortcut } from '@andrewbehma/glass-ui/use-command-palette-shortcut';
import { LIVE_CLOSE_CODES, type PublicUser } from '@nautelle/shared';
import { ArrowLeft, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { api, describeError } from '../../lib/api';
import { useLiveStatus } from '../../lib/live/use-live';
import { Assistant } from '../assistant/assistant';
import { AskBoardDialog } from '../board-ai/ask-board-dialog';
import { RunnerUpdateNotice } from '../runners/runner-update-notice';
import { useRunnerUpdate } from '../runners/use-runner-update';
import { AccountMenu } from './account-menu';
import { Capsule } from './capsule';
import { crumbsFor, pageTitleOf } from './crumbs';
import { useKeyboardOpen } from './keyboard';
import {
  liveDotLabel,
  RESTARTING_BANNER_TEXT,
  useLivePaused,
  useServerRestarting,
} from './live-status';
import { useNarrow } from './narrow';
import {
  activeEntryId,
  isFillEntry,
  isWideEntry,
  projectIdOf,
  tabBarSplit,
  visibleNav,
} from './nav';
import { NotificationBell } from './notification-bell';
import { ASK_PREFIX, paletteGroups } from './palette';
import { Rail } from './rail';
import { useRailCollapsed, useRailToggleShortcut } from './rail-collapse';
import {
  applyTheme,
  readStoredTheme,
  storeTheme,
  THEME_LABEL,
  THEME_MODES,
  type ThemeMode,
} from './theme';
import { useCrumbNames } from './use-crumb-names';
import { useDocumentTitle } from './use-document-title';
import { PageActionsProvider } from './use-page-actions';
import { usePlans, useProjects, useRecent } from './use-shell-data';
import { useSlotsNeedingAttention } from './use-slots-needing-attention';
import { useWaitingApprovals } from './use-waiting-approvals';
import { UserProvider } from './user-context';
import { WhatsNewProvider } from './whats-new-context';

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

function ConnectionDot({ status, paused }: ReturnType<typeof useLivePaused>) {
  const label = liveDotLabel(status, paused);
  const tone = status === 'connected' ? 'ok' : 'warn';
  return (
    <Tooltip content={label}>
      <span className="inline-flex size-4 shrink-0 items-center justify-center">
        <Badge dot tone={tone} className="size-2" aria-hidden="true" />
        <span className="sr-only" role="status">
          {label}
        </span>
      </span>
    </Tooltip>
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
  // #526: the soft keyboard replaces the capsule, so a docked action stays above it.
  const keyboard = useKeyboardOpen();
  const [theme, setTheme] = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  // #660: the question asked from the palette; null while none is open.
  const [asking, setAsking] = useState<string | null>(null);
  const projectId = projectIdOf(pathname);
  const projects = useProjects();
  const recent = useRecent(paletteOpen, projectId);
  const plans = usePlans(paletteOpen, projectId);
  const names = useCrumbNames(pathname, projects);

  useCommandPaletteShortcut(() => setPaletteOpen(true));

  // On a desktop the rail narrows to icons and back (C-14); ⌘\ toggles it.
  // A tablet's rail is always icons (C-282), so the toggle is a desktop's.
  const desktop = useBreakpoint() === 'desktop';
  const [railCollapsed, setRailCollapsed] = useRailCollapsed();
  const toggleRail = useCallback(
    () => setRailCollapsed(!railCollapsed),
    [railCollapsed, setRailCollapsed],
  );
  useRailToggleShortcut(desktop, toggleRail);

  // The bell holds the `user:<id>` subscription that keeps the socket (and the dot) alive.
  const { status, closeCode } = useLiveStatus();
  const live = useLivePaused();
  const restarting = useServerRestarting();
  // C-328: the caller's own runner is behind the latest release.
  const runnerUpdate = useRunnerUpdate();
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
  const wide = isWideEntry(sections, activeId);
  // Locked to the viewport only where there is a rail; a phone scrolls the page.
  const fill = isFillEntry(sections, activeId, pathname) && !narrow;
  const project = projects.find((each) => each.id === projectId);
  const projectName = project?.displayName;
  // Inside a project the project's role (min of global and override) decides
  // which page actions show; a project not loaded yet shows none.
  const role = projectId ? (project?.role ?? 'viewer') : user.role;

  const crumbs = useMemo(() => crumbsFor(pathname, names), [pathname, names]);
  useDocumentTitle(pageTitleOf(crumbs, projectName));
  const parent = crumbs.length > 1 ? crumbs.at(-2) : undefined;

  // The rail's badges on Approvals and Fleet; More's "Needs you" elsewhere.
  const waitingApprovals = useWaitingApprovals(projectId);
  const slotsNeedingAttention = useSlotsNeedingAttention(projectId);

  // On a phone: Board, Queue and Activity (C-282), the rest in More's sheet.
  const { tabs, more } = useMemo(() => tabBarSplit(sections), [sections]);

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
      plans,
      themeLabel: THEME_LABEL[theme],
    });

  const onSelect = (item: { id: string }) => {
    setPaletteOpen(false);
    if (item.id.startsWith('go:')) router.push(item.id.slice(3));
    else if (item.id.startsWith(ASK_PREFIX)) {
      setAsking(item.id.slice(ASK_PREFIX.length));
    } else if (item.id === 'action:theme') cycleTheme();
    else if (item.id === 'action:logout') void logout();
  };

  const displayName = user.name ?? user.email;

  return (
    <UserProvider value={user}>
      <WhatsNewProvider>
        <PageActionsProvider>
          <a
            href="#main-content"
            className="glass-strong sr-only z-overlay rounded-control px-3 py-2 text-sm text-ink focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
          >
            Skip to content
          </a>
          <div
            // On a phone the page sits on a 16 px gutter (#213).
            className={`flex ${fill ? 'h-screen overflow-hidden' : 'min-h-screen'} ${narrow ? 'gap-2 px-4 py-2' : 'gap-3 p-3'}`}
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
                  collapsed={railCollapsed}
                  onCollapsedChange={setRailCollapsed}
                />
              </aside>
            )}

            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
              <header
                // #654: one row of `--size-control` controls on a shared centre
                // line — the trail and its live dot left, one group right.
                className={`glass rounded-surface flex h-14 shrink-0 items-center ${narrow ? 'gap-1 px-2' : 'gap-3 pr-3 pl-4'}`}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  {narrow ? (
                    // A phone has no room for the trail: the page, and a way up.
                    <>
                      {parent?.href ? (
                        <Link
                          href={parent.href}
                          aria-label={`Back to ${parent.label}`}
                          className="flex size-(--size-control) shrink-0 items-center justify-center rounded-control text-ink-2 hover:bg-hover hover:text-ink"
                        >
                          <ArrowLeft size={16} aria-hidden="true" />
                        </Link>
                      ) : null}
                      <span className="truncate text-section text-ink">
                        {crumbs.at(-1)?.label}
                      </span>
                    </>
                  ) : (
                    <Breadcrumb
                      items={crumbs}
                      aria-label="Breadcrumb"
                      overflowLabel="Show the path"
                      // The page itself is set in the section style (S-4 mockup).
                      className="min-w-0 [&_[aria-current=page]]:text-section [&_[aria-current=page]]:font-semibold"
                      link={({
                        href,
                        className,
                        children: content,
                        ...rest
                      }) => (
                        <Link href={href} className={className} {...rest}>
                          {content}
                        </Link>
                      )}
                    />
                  )}
                  <ConnectionDot {...live} />
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant={narrow ? 'ghost' : 'glass'}
                    size="md"
                    icon={narrow}
                    onClick={() => setPaletteOpen(true)}
                    aria-label="Open command palette"
                    className={
                      narrow ? undefined : 'mr-1 w-56 justify-start gap-2 px-2'
                    }
                  >
                    <Search size={14} aria-hidden="true" />
                    {narrow ? null : (
                      <>
                        <span className="flex-1 text-left font-normal text-ink-3">
                          Search…
                        </span>
                        <KeyHint keys="mod+k" />
                      </>
                    )}
                  </Button>
                  <NotificationBell />
                  <Separator orientation="vertical" className="mx-1 h-4" />
                  <AccountMenu
                    displayName={displayName}
                    role={user.role}
                    theme={theme}
                    onThemeChange={setTheme}
                    onLogout={() => void logout()}
                  />
                </div>
              </header>

              {restarting ? (
                <Banner tone="warn">{RESTARTING_BANNER_TEXT}</Banner>
              ) : null}

              {!restarting &&
              live.paused &&
              closeCode !== LIVE_CLOSE_CODES.unauthorized ? (
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

              {runnerUpdate.notice ? (
                <RunnerUpdateNotice
                  notice={runnerUpdate.notice}
                  onDismiss={runnerUpdate.dismiss}
                />
              ) : null}

              <main
                id="main-content"
                tabIndex={-1}
                // A data page (the registry's `wide`) gets the wide column.
                className={
                  fill
                    ? 'flex min-h-0 w-full flex-1 flex-col focus:outline-none'
                    : `mx-auto w-full pb-6 focus:outline-none ${wide ? 'max-w-7xl' : 'max-w-5xl'}`
                }
              >
                {children}
              </main>

              {narrow && !keyboard ? (
                // On a phone the capsule replaces the rail; its spacer keeps the
                // page's end clear of it. #526: the soft keyboard hides it.
                <Capsule
                  sections={sections}
                  tabs={tabs}
                  more={more}
                  activeId={activeId}
                  projects={projects}
                  projectId={projectId}
                  projectName={projectName}
                  role={role}
                  waitingApprovals={waitingApprovals}
                  slotsNeedingAttention={slotsNeedingAttention}
                />
              ) : null}
            </div>
          </div>

          <Assistant projects={projects} />

          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            search={search}
            onSelect={onSelect}
            placeholder="Go to a page, a project or a run — or ask the Board"
          />
          <AskBoardDialog
            question={asking}
            onOpenChange={(open) => {
              if (!open) setAsking(null);
            }}
          />
        </PageActionsProvider>
      </WhatsNewProvider>
    </UserProvider>
  );
}
