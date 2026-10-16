'use client';

import type { ProjectSummary, Role } from '@agentdock/shared';
import { ActionList } from '@andrewbehma/glass-ui/action-list';
import {
  BottomCapsule,
  type BottomCapsuleProps,
} from '@andrewbehma/glass-ui/bottom-capsule';
import { SheetContent, SheetRoot } from '@andrewbehma/glass-ui/sheet';
import { Plus, SquarePen } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { approvalsBadge } from '../../lib/approvals/format';
import { boardNewWorkHref } from '../../lib/board/href';
import { attentionBadge } from '../../lib/fleet/format';
import type { VisibleEntry, VisibleSection } from './nav';
import { capsuleAction, type PageAction } from './page-actions';
import { ProjectSwitcher } from './project-switcher';
import { useRegisteredPageActions } from './use-page-actions';

/** The `+` sheet grows out of the circle (`morphFrom`). */
const ACTIONS_MORPH = 'shell-page-actions';

/** The capsule's and More's anchors are Next links. */
const renderLink: NonNullable<BottomCapsuleProps['link']> = ({
  href,
  className,
  children: content,
  ...rest
}) => (
  <Link href={href} className={className} {...rest}>
    {content}
  </Link>
);

/**
 * Below `lg` (#521): glass-ui's floating BottomCapsule — three places, More's
 * sheet for the rest, and the page's create action on the `+` beside it.
 */
export function Capsule({
  tabs,
  more,
  activeId,
  projects,
  projectId,
  projectName,
  role,
  waitingApprovals,
  slotsNeedingAttention,
}: {
  tabs: VisibleEntry[];
  more: VisibleSection[];
  activeId: string | null;
  projects: ProjectSummary[];
  projectId: string | null;
  projectName: string | undefined;
  /** The caller's effective role here: the project's inside one. */
  role: Role;
  waitingApprovals: number;
  slotsNeedingAttention: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger
  useEffect(() => {
    setMoreOpen(false);
    setActionsOpen(false);
  }, [pathname]);

  const registered = useRegisteredPageActions();
  const fallback = useMemo<PageAction | null>(
    () =>
      projectId
        ? {
            id: 'new-work',
            label: 'New work',
            icon: SquarePen,
            onSelect: () => router.push(boardNewWorkHref(projectId)),
            operatorOnly: true,
          }
        : null,
    [projectId, router],
  );
  const plus = capsuleAction(registered, role, fallback);

  // BottomCapsuleTab has no `badge` (docs/ui/glass-ui.md): the counts the
  // rail shows on Approvals and Fleet head More's sheet instead.
  const needsYou = tabs.flatMap((entry) => {
    const badge =
      entry.id === 'approvals'
        ? approvalsBadge(waitingApprovals)
        : entry.id === 'fleet'
          ? attentionBadge(slotsNeedingAttention)
          : undefined;
    return badge
      ? [
          {
            id: `needs-${entry.id}`,
            label: entry.label,
            icon: entry.icon,
            description: badge.label,
            href: entry.resolvedHref,
          },
        ]
      : [];
  });

  return (
    <>
      <BottomCapsule
        aria-label="Main"
        tabSizing="content"
        tabs={tabs.map((entry) => ({
          id: entry.id,
          label: entry.label,
          icon: entry.icon,
          href: entry.resolvedHref,
          active: entry.id === activeId,
        }))}
        link={renderLink}
        action={
          plus.kind === 'run'
            ? {
                label: plus.action.label,
                icon: Plus,
                onSelect: plus.action.onSelect,
              }
            : plus.kind === 'sheet'
              ? {
                  label: 'Create',
                  icon: Plus,
                  onSelect: () => setActionsOpen(true),
                  morphFrom: ACTIONS_MORPH,
                  open: actionsOpen,
                }
              : undefined
        }
        more={{
          label: 'More',
          title: 'More pages',
          open: moreOpen,
          onOpenChange: setMoreOpen,
          children: (
            <div className="flex flex-col gap-4">
              <ProjectSwitcher projects={projects} projectId={projectId} />
              {needsYou.length > 0 ? (
                <ActionList
                  surface="content"
                  heading="Needs you"
                  link={renderLink}
                  items={needsYou}
                />
              ) : null}
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
        }}
      />
      {plus.kind === 'sheet' ? (
        <SheetRoot open={actionsOpen} onOpenChange={setActionsOpen}>
          <SheetContent title="Create" side="bottom" morphFrom={ACTIONS_MORPH}>
            <ActionList
              surface="content"
              items={plus.actions.map((action) => ({
                id: action.id,
                label: action.label,
                icon: action.icon,
                onSelect: () => {
                  setActionsOpen(false);
                  action.onSelect();
                },
              }))}
            />
          </SheetContent>
        </SheetRoot>
      ) : null}
    </>
  );
}
