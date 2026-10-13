'use client';

import type { ProjectSummary } from '@agentdock/shared';
import { NavRail, type NavRailGroup } from '@andrewbehma/glass-ui/nav-rail';
import { useScrollEdges } from '@andrewbehma/glass-ui/use-scroll-edges';
import { ChevronDown, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { navLabel } from '../../lib/approvals/format';
import { Logomark, Wordmark } from '../brand';
import type { VisibleSection } from './nav';
import { ProjectSwitcher } from './project-switcher';

const ADMIN_OPEN_KEY = 'agentdock.nav.admin-open';

/** Whether the Admin group is unfolded, remembered per browser. */
function useAdminOpen(): [boolean, () => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      setOpen(window.localStorage.getItem(ADMIN_OPEN_KEY) === '1');
    } catch {
      // Storage blocked: the group starts folded.
    }
  }, []);
  const toggle = useCallback(() => {
    setOpen((was) => {
      try {
        window.localStorage.setItem(ADMIN_OPEN_KEY, was ? '0' : '1');
      } catch {
        // Not remembered; the toggle still works for this page.
      }
      return !was;
    });
  }, []);
  return [open, toggle];
}

/**
 * NavRail's scroll box is its own element, with no `ref` or `className` of its
 * own (glass-ui 0.23.0). This finds it, fades the edge that has more behind
 * it, and scrolls the active item into view on every navigation.
 * A stop-gap until NavRail draws the fade itself (glass-ui#94).
 */
function useRailScroll(activeId: string | null) {
  const container = useRef<HTMLDivElement>(null);
  const { ref, edges, onScroll } = useScrollEdges<HTMLDivElement>('y');

  useLayoutEffect(() => {
    const scroller = container.current?.querySelector<HTMLDivElement>(
      'nav > .overflow-y-auto',
    );
    if (!scroller) return;
    ref.current = scroller;
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [ref, onScroll]);

  useEffect(() => {
    const scroller = ref.current;
    if (!scroller) return;
    const top = edges.start ? '24px' : '0px';
    const bottom = edges.end ? 'calc(100% - 24px)' : '100%';
    // A mask, not a colour: only its alpha matters, so it fits any surface.
    const mask = `linear-gradient(to bottom, transparent 0, black ${top}, black ${bottom}, transparent 100%)`;
    scroller.style.maskImage = mask;
    scroller.style.webkitMaskImage = mask;
  }, [ref, edges]);

  useEffect(() => {
    if (!activeId) return;
    ref.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [ref, activeId]);

  return container;
}

/**
 * The left rail (#159): Workspace, the project's own section titled with its
 * name, then Admin folded into one group unless one of its pages is open.
 * Exactly one item is active (`activeId`, from `activeEntryId`).
 */
export function Rail({
  sections,
  activeId,
  narrow,
  projects,
  projectId,
  waitingApprovals,
}: {
  sections: readonly VisibleSection[];
  activeId: string | null;
  narrow: boolean;
  projects: readonly ProjectSummary[];
  projectId: string | null;
  waitingApprovals: number;
}) {
  const [adminOpen, toggleAdmin] = useAdminOpen();
  const container = useRailScroll(activeId);
  const projectName = projects.find(
    (project) => project.id === projectId,
  )?.displayName;

  const groups: NavRailGroup[] = sections.map((section) => {
    const items = section.entries.map((entry) => ({
      id: entry.id,
      label:
        entry.id === 'approvals'
          ? navLabel(entry.label, waitingApprovals)
          : entry.label,
      icon: entry.icon,
      href: entry.resolvedHref,
      active: entry.id === activeId,
    }));
    const title =
      section.id === 'project' && projectName ? projectName : section.title;
    if (!section.collapsible) return { id: section.id, title, items };

    // An open admin page keeps its group unfolded: the active item stays seen.
    if (items.some((item) => item.active)) {
      return { id: section.id, title, items };
    }
    // NavRail has no expandable group yet (glass-ui#94): a toggle item does it,
    // and says what it does in its name since it cannot carry aria-expanded.
    const toggle = {
      id: `${section.id}-toggle`,
      label: adminOpen
        ? `Hide ${section.title.toLowerCase()} pages`
        : `Show ${section.title.toLowerCase()} pages`,
      icon: adminOpen ? ChevronDown : ChevronRight,
      onSelect: toggleAdmin,
    };
    return {
      id: section.id,
      title,
      items: adminOpen ? [toggle, ...items] : [toggle],
    };
  });

  return (
    <div ref={container} className="h-full">
      <NavRail
        aria-label="Main"
        groups={groups}
        collapsed={narrow}
        className="h-full"
        head={
          <div className="flex flex-col gap-3">
            <Link
              href="/"
              aria-label="AgentDock, overview"
              className={
                narrow
                  ? 'mx-auto flex size-10 items-center justify-center rounded-control text-ink'
                  : 'flex items-center rounded-control px-3 pt-1 text-ink'
              }
            >
              {narrow ? <Logomark size={22} accent /> : <Wordmark size="md" />}
            </Link>
            <ProjectSwitcher
              projects={projects}
              projectId={projectId}
              compact={narrow}
            />
          </div>
        }
        link={({ href, className, children: content, ...rest }) => (
          <Link href={href} className={className} {...rest}>
            {content}
          </Link>
        )}
      />
    </div>
  );
}
