'use client';

import type { ProjectSummary } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import {
  NavRail,
  type NavRailGroup,
  type RailBadge,
} from '@andrewbehma/glass-ui/nav-rail';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { approvalsBadge } from '../../lib/approvals/format';
import { attentionBadge } from '../../lib/fleet/format';
import { Logomark, Wordmark } from '../brand';
import { railGroups, type VisibleSection } from './nav';
import { ProjectSwitcher } from './project-switcher';
import { railToggleLabel } from './rail-collapse';

/** One key per foldable group, so each remembers its own state. */
const OPEN_KEYS = {
  admin: 'agentdock.nav.admin-open',
  workspace: 'agentdock.nav.workspace.open',
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
 * The left rail (#159, #163), from `lg` up: Workspace, the project's own
 * section titled with its name (its working pages, then a More group), then
 * Admin. Inside a project Workspace folds too (C-247). A folded group is
 * unfolded by NavRail itself while one of its pages is open. Exactly one item is active
 * (`activeId`, from `activeEntryId`). Below `lg` the shell draws a
 * BottomCapsule instead.
 *
 * `collapsed` (C-14) narrows it to NavRail's icon column; the toggle sits in
 * the head, right of the wordmark, and under the mark once collapsed.
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
    admin: useRememberedOpen(OPEN_KEYS.admin),
    workspace: useRememberedOpen(OPEN_KEYS.workspace),
    'project-more': useRememberedOpen(OPEN_KEYS['project-more']),
  };
  const projectName = projects.find(
    (project) => project.id === projectId,
  )?.displayName;

  const badges: Record<string, RailBadge | undefined> = {
    approvals: approvalsBadge(waitingApprovals),
    fleet: attentionBadge(slotsNeedingAttention),
  };

  const groups: NavRailGroup[] = railGroups(sections).map((group) => {
    const items = group.entries.map((entry) => ({
      id: entry.id,
      label: entry.label,
      icon: entry.icon,
      href: entry.resolvedHref,
      active: entry.id === activeId,
      badge: badges[entry.id],
    }));
    const title =
      group.id === 'project' && projectName ? projectName : group.title;
    if (!group.collapsible || group.id === 'project') {
      return { id: group.id, title, items };
    }
    const [open, setOpen] = openState[group.id];
    // NavRailGroup has no badge slot: while folded, Fleet's count rides the title.
    const flagged =
      group.id === 'project-more' && !open && slotsNeedingAttention > 0;
    return {
      id: group.id,
      title: flagged ? `${title} · ${slotsNeedingAttention}` : title,
      items,
      collapsible: true,
      open,
      onOpenChange: setOpen,
    };
  });

  return (
    <NavRail
      aria-label="Main"
      groups={groups}
      className="h-full"
      collapsed={collapsed}
      head={
        <div className="flex flex-col gap-3">
          {/* The logo row is as tall as the top bar's inner row (rail p-2 + h-10 = header h-14), so the two line up. */}
          <div
            className={`flex gap-1 ${collapsed ? 'flex-col items-stretch' : 'items-center'}`}
          >
            <Link
              href="/"
              aria-label="AgentDock, overview"
              className={`flex min-w-0 items-center rounded-control text-ink h-10 ${collapsed ? 'justify-center' : 'flex-1 px-3'}`}
            >
              {collapsed ? (
                <Logomark size={22} accent />
              ) : (
                <Wordmark size="md" />
              )}
            </Link>
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
          </div>
          <ProjectSwitcher
            projects={projects}
            projectId={projectId}
            compact={collapsed}
          />
        </div>
      }
      link={({ href, className, children: content, ...rest }) => (
        <Link href={href} className={className} {...rest}>
          {content}
        </Link>
      )}
    />
  );
}
