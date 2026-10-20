'use client';

import type { ProjectSummary } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import {
  NavRail,
  type NavRailGroup,
  type RailBadge,
} from '@andrewbehma/glass-ui/nav-rail';
import { SheetContent, SheetRoot } from '@andrewbehma/glass-ui/sheet';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import { useBreakpoint } from '@andrewbehma/glass-ui/use-breakpoint';
import { Ellipsis, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { approvalsBadge } from '../../lib/approvals/format';
import { attentionBadge } from '../../lib/fleet/format';
import { Logomark, Wordmark } from '../brand';
import { MorePages } from './more-pages';
import {
  iconRailSplit,
  type RailGroupSpec,
  railGroups,
  type VisibleEntry,
  type VisibleSection,
} from './nav';
import { ProjectSwitcher } from './project-switcher';
import { railToggleLabel } from './rail-collapse';

/** One key per foldable group, so each remembers its own state. */
const OPEN_KEYS = {
  'workspace-more': 'agentdock.nav.workspaceMore.open',
  'project-more': 'agentdock.nav.projectMore.open',
} as const;

/** Whether a group is unfolded, remembered per browser; folded when storage is blocked. */
function useRememberedOpen(key: string): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      setOpen(window.localStorage.getItem(key) === '1');
    } catch {
      // Storage blocked: the group starts folded.
    }
  }, [key]);
  const change = useCallback(
    (next: boolean) => {
      setOpen(next);
      try {
        window.localStorage.setItem(key, next ? '1' : '0');
      } catch {
        // Not remembered; the toggle still works for this page.
      }
    },
    [key],
  );
  return [open, change];
}

/**
 * The left rail (#159, #163, C-282), from `sm` up. Open (a desktop): each
 * section's primary entries — Workspace's Overview, Projects and Work, then
 * the project's five under its name, the Board first in glass-ui's
 * primary-entry frame — each followed by a folding More group with the rest.
 * Folded to icons (a tablet, by CSS through `collapsed="tablet"`, or the
 * desktop rail collapsed, C-14): the same primary entries, and one More item
 * that opens a sheet with everything else. Admin is in the account menu, not
 * here. Exactly one item is active (`activeId`, from `activeEntryId`).
 *
 * The collapse toggle sits in the head, right of the wordmark, and under the
 * mark once collapsed; a tablet has no toggle, its rail is always folded.
 */
export function Rail({
  sections,
  activeId,
  projects,
  projectId,
  waitingApprovals,
  slotsNeedingAttention,
  collapsed,
  onCollapsedChange,
}: {
  sections: readonly VisibleSection[];
  activeId: string | null;
  projects: readonly ProjectSummary[];
  projectId: string | null;
  waitingApprovals: number;
  slotsNeedingAttention: number;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const openState = {
    'workspace-more': useRememberedOpen(OPEN_KEYS['workspace-more']),
    'project-more': useRememberedOpen(OPEN_KEYS['project-more']),
  };
  const [moreOpen, setMoreOpen] = useState(false);
  const pathname = usePathname();
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger
  useEffect(() => setMoreOpen(false), [pathname]);
  // The server and the first render answer `desktop`; the fold itself is CSS.
  const tablet = useBreakpoint() === 'tablet';
  const iconOnly = collapsed || tablet;
  const projectName = projects.find(
    (project) => project.id === projectId,
  )?.displayName;

  const badges: Record<string, RailBadge | undefined> = {
    approvals: approvalsBadge(waitingApprovals),
    fleet: attentionBadge(slotsNeedingAttention),
  };
  const item = (entry: VisibleEntry) => ({
    id: entry.id,
    label: entry.label,
    icon: entry.icon,
    href: entry.resolvedHref,
    active: entry.id === activeId,
    badge: badges[entry.id],
    primary: entry.main,
  });
  const titleOf = (id: string, title: string) =>
    id === 'project' && projectName ? projectName : title;

  const openGroup = (group: RailGroupSpec): NavRailGroup => {
    const items = group.entries.map(item);
    const title = titleOf(group.id, group.title);
    if (group.id !== 'workspace-more' && group.id !== 'project-more') {
      return { id: group.id, title, items };
    }
    const [open, setOpen] = openState[group.id];
    // NavRailGroup has no badge slot: while folded, Approvals' count rides the title.
    const flagged =
      group.id === 'project-more' && !open && waitingApprovals > 0;
    return {
      id: group.id,
      title: flagged ? `${title} · ${waitingApprovals}` : title,
      items,
      collapsible: true,
      open,
      onOpenChange: setOpen,
    };
  };

  const iconSplit = iconRailSplit(sections);
  const hiddenIds = iconSplit.more.flatMap((section) =>
    section.entries.map((entry) => entry.id),
  );
  const groups: NavRailGroup[] = iconOnly
    ? [
        ...iconSplit.shown.map((section) => ({
          id: section.id,
          title: titleOf(section.id, section.title),
          items: section.entries.map(item),
        })),
        {
          id: 'more',
          title: 'More',
          items: [
            {
              id: 'more',
              label: 'More',
              icon: Ellipsis,
              onSelect: () => setMoreOpen(true),
              active: activeId !== null && hiddenIds.includes(activeId),
              badge: hiddenIds.includes('approvals')
                ? badges.approvals
                : undefined,
            },
          ],
        },
      ]
    : railGroups(sections).map(openGroup);

  return (
    <>
      <NavRail
        aria-label="Main"
        groups={groups}
        className="h-full"
        collapsed={collapsed ? true : 'tablet'}
        head={
          <div className="flex flex-col gap-3">
            {/* The logo row is as tall as the top bar's inner row (rail p-2 + h-10 = header h-14), so the two line up. */}
            <div
              className={`flex gap-1 ${iconOnly ? 'flex-col items-stretch' : 'items-center'}`}
            >
              <Link
                href="/"
                aria-label="AgentDock, overview"
                className={`flex min-w-0 items-center rounded-control text-ink h-10 ${iconOnly ? 'justify-center' : 'flex-1 px-3'}`}
              >
                {iconOnly ? (
                  <Logomark size={22} accent />
                ) : (
                  <Wordmark size="md" />
                )}
              </Link>
              {tablet ? null : (
                <Tooltip content={railToggleLabel(collapsed)} side="right">
                  <Button
                    variant="ghost"
                    size="md"
                    icon={!collapsed}
                    full={collapsed}
                    onClick={() => onCollapsedChange(!collapsed)}
                    aria-label={railToggleLabel(collapsed)}
                    aria-expanded={!collapsed}
                    aria-keyshortcuts={'Meta+\\ Control+\\'}
                    className="h-8 shrink-0 px-0 text-ink-3"
                  >
                    {collapsed ? (
                      <PanelLeftOpen size={18} aria-hidden="true" />
                    ) : (
                      <PanelLeftClose size={18} aria-hidden="true" />
                    )}
                  </Button>
                </Tooltip>
              )}
            </div>
            <ProjectSwitcher
              projects={projects}
              projectId={projectId}
              compact={iconOnly}
            />
          </div>
        }
        link={({ href, className, children: content, ...rest }) => (
          <Link href={href} className={className} {...rest}>
            {content}
          </Link>
        )}
      />
      {iconOnly ? (
        <SheetRoot open={moreOpen} onOpenChange={setMoreOpen}>
          <SheetContent title="More pages" side="right">
            <MorePages
              sections={sections}
              more={iconSplit.more}
              projects={projects}
              projectId={projectId}
              projectName={projectName}
              waitingApprovals={waitingApprovals}
              slotsNeedingAttention={slotsNeedingAttention}
              switcher={false}
            />
          </SheetContent>
        </SheetRoot>
      ) : null}
    </>
  );
}
