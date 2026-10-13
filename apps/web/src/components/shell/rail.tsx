'use client';

import type { ProjectSummary } from '@agentdock/shared';
import {
  NavRail,
  type NavRailGroup,
  type RailBadge,
} from '@andrewbehma/glass-ui/nav-rail';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { approvalsBadge } from '../../lib/approvals/format';
import { attentionBadge } from '../../lib/fleet/format';
import { Wordmark } from '../brand';
import type { VisibleSection } from './nav';
import { ProjectSwitcher } from './project-switcher';

const ADMIN_OPEN_KEY = 'agentdock.nav.admin-open';

/** Whether the Admin group is unfolded, remembered per browser. */
function useAdminOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      setOpen(window.localStorage.getItem(ADMIN_OPEN_KEY) === '1');
    } catch {
      // Storage blocked: the group starts folded.
    }
  }, []);
  const change = useCallback((next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(ADMIN_OPEN_KEY, next ? '1' : '0');
    } catch {
      // Not remembered; the toggle still works for this page.
    }
  }, []);
  return [open, change];
}

/**
 * The left rail (#159, #163), from `lg` up: Workspace, the project's own
 * section titled with its name, then Admin as a collapsible group that NavRail
 * unfolds by itself while one of its pages is open. Exactly one item is active
 * (`activeId`, from `activeEntryId`). Below `lg` the shell draws a TabBar
 * instead.
 */
export function Rail({
  sections,
  activeId,
  projects,
  projectId,
  waitingApprovals,
  slotsNeedingAttention,
}: {
  sections: readonly VisibleSection[];
  activeId: string | null;
  projects: readonly ProjectSummary[];
  projectId: string | null;
  waitingApprovals: number;
  slotsNeedingAttention: number;
}) {
  const [adminOpen, setAdminOpen] = useAdminOpen();
  const projectName = projects.find(
    (project) => project.id === projectId,
  )?.displayName;

  const badges: Record<string, RailBadge | undefined> = {
    approvals: approvalsBadge(waitingApprovals),
    fleet: attentionBadge(slotsNeedingAttention),
  };

  const groups: NavRailGroup[] = sections.map((section) => {
    const items = section.entries.map((entry) => ({
      id: entry.id,
      label: entry.label,
      icon: entry.icon,
      href: entry.resolvedHref,
      active: entry.id === activeId,
      badge: badges[entry.id],
    }));
    const title =
      section.id === 'project' && projectName ? projectName : section.title;
    if (!section.collapsible) return { id: section.id, title, items };
    return {
      id: section.id,
      title,
      items,
      collapsible: true,
      open: adminOpen,
      onOpenChange: setAdminOpen,
    };
  });

  return (
    <NavRail
      aria-label="Main"
      groups={groups}
      className="h-full"
      head={
        <div className="flex flex-col gap-3">
          <Link
            href="/"
            aria-label="AgentDock, overview"
            className="flex items-center rounded-control px-3 pt-1 text-ink"
          >
            <Wordmark size="md" />
          </Link>
          <ProjectSwitcher projects={projects} projectId={projectId} />
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
