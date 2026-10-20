'use client';

import type { ProjectSummary } from '@agentdock/shared';
import {
  ActionList,
  type ActionListProps,
} from '@andrewbehma/glass-ui/action-list';
import type { RailBadge } from '@andrewbehma/glass-ui/nav-rail';
import Link from 'next/link';
import { approvalsBadge } from '../../lib/approvals/format';
import { attentionBadge } from '../../lib/fleet/format';
import type { VisibleSection } from './nav';
import { ProjectSwitcher } from './project-switcher';

/** More's anchors are Next links. */
export const renderLink: NonNullable<ActionListProps['link']> = ({
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
 * What More holds (#521, C-282), on the phone's capsule and on the icon rail
 * alike: the project switcher, a "Needs you" group with the waiting approvals
 * and the slots that need a person (neither the capsule's tabs nor a folded
 * rail spell the counts out), then every page that is not in view, by section.
 */
export function MorePages({
  sections,
  more,
  projects,
  projectId,
  projectName,
  waitingApprovals,
  slotsNeedingAttention,
  switcher = true,
}: {
  /** Every section the role sees here, for the entries "Needs you" points at. */
  sections: readonly VisibleSection[];
  /** The pages not in view, by section. */
  more: readonly VisibleSection[];
  projects: readonly ProjectSummary[];
  projectId: string | null;
  projectName: string | undefined;
  waitingApprovals: number;
  slotsNeedingAttention: number;
  /** The rail draws its own switcher; the capsule has none but this one. */
  switcher?: boolean;
}) {
  const counts: Record<'approvals' | 'fleet', RailBadge | undefined> = {
    approvals: approvalsBadge(waitingApprovals),
    fleet: attentionBadge(slotsNeedingAttention),
  };
  const entries = sections.flatMap((section) => section.entries);
  const needsYou = (['approvals', 'fleet'] as const).flatMap((id) => {
    const entry = entries.find((each) => each.id === id);
    const badge = counts[id];
    return entry && badge
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
    <div className="flex flex-col gap-4">
      {switcher ? (
        <ProjectSwitcher projects={projects} projectId={projectId} />
      ) : null}
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
  );
}
