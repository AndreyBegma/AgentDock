'use client';

import { ActionList } from '@andrewbehma/glass-ui/action-list';
import { BottomCapsule } from '@andrewbehma/glass-ui/bottom-capsule';
import { SheetContent, SheetRoot } from '@andrewbehma/glass-ui/sheet';
import type { ProjectSummary, Role } from '@nautelle/shared';
import { Plus, SquarePen } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { boardNewWorkHref } from '../../lib/board/href';
import { MorePages, renderLink } from './more-pages';
import type { VisibleEntry, VisibleSection } from './nav';
import { capsuleAction, type PageAction } from './page-actions';
import { useRegisteredPageActions } from './use-page-actions';

/** The `+` sheet grows out of the circle (`morphFrom`). */
const ACTIONS_MORPH = 'shell-page-actions';

/**
 * On a phone, below `sm` (#521, C-282): glass-ui's floating BottomCapsule —
 * three places, More's sheet for the rest, and the page's create action on the
 * `+` beside it.
 */
export function Capsule({
  sections,
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
  /** Every section the role sees here. */
  sections: VisibleSection[];
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
          // BottomCapsuleTab has no `badge` (docs/ui/glass-ui.md): the counts
          // the rail shows on Queue and Fleet head More's sheet instead.
          children: (
            <MorePages
              sections={sections}
              more={more}
              projects={projects}
              projectId={projectId}
              projectName={projectName}
              waitingApprovals={waitingApprovals}
              slotsNeedingAttention={slotsNeedingAttention}
            />
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
