'use client';

import {
  LIVE_CLOSE_CODES,
  type ProjectSummary,
  type PublicUser,
} from '@agentdock/shared';
import { Avatar } from 'glass-ui/avatar';
import { Badge } from 'glass-ui/badge';
import { Breadcrumb, type BreadcrumbItem } from 'glass-ui/breadcrumb';
import { Button } from 'glass-ui/button';
import {
  CommandPalette,
  type CommandPaletteGroup,
} from 'glass-ui/command-palette';
import { KeyHint } from 'glass-ui/key-hint';
import {
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from 'glass-ui/menu';
import { NavRail, type NavRailGroup } from 'glass-ui/nav-rail';
import { toast } from 'glass-ui/toast';
import { useCommandPaletteShortcut } from 'glass-ui/use-command-palette-shortcut';
import { FolderGit2, LogOut, Palette, Search, User } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { api, describeError } from '../../lib/api';
import { useLiveStatus } from '../../lib/live/use-live';
import { isActive, NAV, projectIdOf, visibleNav } from './nav';
import { NotificationBell } from './notification-bell';
import { ProjectSwitcher } from './project-switcher';
import {
  applyTheme,
  isThemeMode,
  readStoredTheme,
  storeTheme,
  THEME_LABEL,
  THEME_MODES,
  type ThemeMode,
} from './theme';
import { UserProvider } from './user-context';

const COLLAPSE_QUERY = '(max-width: 1023px)';

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

const titleCase = (segment: string) =>
  segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, ' ');

/** Breadcrumb of the current route, labelled from the nav registry where it knows the page. */
function crumbsFor(pathname: string): BreadcrumbItem[] {
  if (pathname === '/') return [{ id: 'overview', label: 'Overview' }];
  const known = new Map<string, string>();
  for (const section of NAV) {
    for (const entry of section.entries) known.set(entry.href, entry.label);
  }
  known.set('/account', 'Account');
  known.set('/admin', 'Admin');

  const segments = pathname.split('/').filter(Boolean);
  return segments.map((segment, index) => {
    const href = `/${segments.slice(0, index + 1).join('/')}`;
    const last = index === segments.length - 1;
    return {
      id: href,
      label: known.get(href) ?? titleCase(segment),
      // `/admin` has no page of its own.
      href: last || href === '/admin' ? undefined : href,
    };
  });
}

const LIVE_DOT: Record<
  'connected' | 'reconnecting' | 'offline',
  { tone: 'ok' | 'warn' | 'neutral'; label: string }
> = {
  connected: { tone: 'ok', label: 'Live updates connected' },
  reconnecting: { tone: 'warn', label: 'Live updates reconnecting' },
  offline: { tone: 'neutral', label: 'Live updates offline' },
};

function ConnectionDot() {
  const { status } = useLiveStatus();
  const { tone, label } = LIVE_DOT[status];
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
  const [projects, setProjects] = useState<ProjectSummary[]>([]);

  useEffect(() => {
    api<ProjectSummary[]>('/projects')
      .then((list) => setProjects(Array.isArray(list) ? list : []))
      .catch(() => {
        // No project entries in the palette.
      });
  }, []);

  useCommandPaletteShortcut(() => setPaletteOpen(true));

  // The bell holds the `user:<id>` subscription that keeps the socket (and the dot) alive.
  const { status, closeCode } = useLiveStatus();
  useEffect(() => {
    if (status === 'offline' && closeCode === LIVE_CLOSE_CODES.unauthorized) {
      router.replace('/login');
    }
  }, [status, closeCode, router]);

  const sections = useMemo(
    () => visibleNav(user.role, pathname),
    [user.role, pathname],
  );

  const groups: NavRailGroup[] = sections.map((section) => ({
    id: section.id,
    title: section.title,
    items: section.entries.map((entry) => ({
      id: entry.id,
      label: entry.label,
      icon: entry.icon,
      href: entry.resolvedHref,
      active: isActive(entry.resolvedHref, pathname),
    })),
  }));

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

  const search = (query: string): CommandPaletteGroup[] => {
    const needle = query.trim().toLowerCase();
    const matches = (label: string) => label.toLowerCase().includes(needle);
    const result: CommandPaletteGroup[] = [];

    const go = sections.flatMap((section) =>
      section.entries
        .filter((entry) => matches(`${section.title} ${entry.label}`))
        .map((entry) => ({
          id: `go:${entry.resolvedHref}`,
          label: entry.label,
          hint: section.title,
          icon: entry.icon,
        })),
    );
    if (matches('account')) {
      go.push({ id: 'go:/account', label: 'Account', hint: 'You', icon: User });
    }
    if (go.length > 0) result.push({ id: 'go', title: 'Go to', items: go });

    const jump = projects
      .filter((project) =>
        matches(`project ${project.displayName} ${project.repo}`),
      )
      .map((project) => ({
        id: `go:/projects/${project.id}`,
        label: project.displayName,
        hint: project.repo,
        icon: FolderGit2,
      }));
    if (jump.length > 0) {
      result.push({ id: 'projects', title: 'Go to project…', items: jump });
    }

    const actions = [
      {
        id: 'action:theme',
        label: 'Switch theme',
        hint: THEME_LABEL[theme],
        icon: Palette,
      },
      { id: 'action:logout', label: 'Log out', icon: LogOut },
    ].filter((item) => matches(item.label));
    if (actions.length > 0) {
      result.push({ id: 'actions', title: 'Actions', items: actions });
    }
    return result;
  };

  const onSelect = (item: { id: string }) => {
    setPaletteOpen(false);
    if (item.id.startsWith('go:')) router.push(item.id.slice(3));
    else if (item.id === 'action:theme') cycleTheme();
    else if (item.id === 'action:logout') void logout();
  };

  const displayName = user.name ?? user.email;

  return (
    <UserProvider value={user}>
      <div className="flex min-h-screen gap-3 p-3">
        <aside className="sticky top-3 h-[calc(100vh-1.5rem)] shrink-0">
          <NavRail
            aria-label="Main"
            groups={groups}
            collapsed={narrow}
            className="h-full"
            head={
              <div className="flex flex-col gap-2">
                <span
                  className={
                    narrow ? 'text-center font-bold' : 'px-3 pt-1 font-bold'
                  }
                >
                  {narrow ? 'AD' : 'AgentDock'}
                </span>
                {narrow ? null : <ProjectSwitcher projectId={projectId} />}
              </div>
            }
            link={({ href, className, children: content, ...rest }) => (
              <Link href={href} className={className} {...rest}>
                {content}
              </Link>
            )}
          />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <header className="glass rounded-surface flex items-center gap-3 px-4 py-2">
            <Breadcrumb
              items={crumbsFor(pathname)}
              aria-label="Breadcrumb"
              overflowLabel="More"
              className="flex-1"
              link={({ href, className, children: content, ...rest }) => (
                <Link href={href} className={className} {...rest}>
                  {content}
                </Link>
              )}
            />
            <ConnectionDot />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
            >
              <Search size={14} aria-hidden="true" />
              <KeyHint keys="mod+k" />
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

          <main id="main-content" className="mx-auto w-full max-w-5xl pb-6">
            {children}
          </main>
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        search={search}
        onSelect={onSelect}
        placeholder="Go to a page or run a command"
      />
    </UserProvider>
  );
}
