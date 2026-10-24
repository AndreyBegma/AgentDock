'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Section } from '@andrewbehma/glass-ui/section';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import type { ProjectSummary } from '@nautelle/shared';
import Link from 'next/link';
import { SLOT_STATUS_LABEL } from '../../lib/fleet/format';
import { slotHref } from '../../lib/fleet/workspace-url';
import { Time } from '../../lib/format/time';
import { projectHue } from '../../lib/hue';
import { type LiveSession, liveSessions } from '../../lib/overview/dashboard';
import { SLOT_PILL_STATUS } from '../../lib/status/pill';
import { Retry } from './shared';
import type { useDashboard } from './use-dashboard';

/** How many sessions the glance shows before "All sessions". */
const LIVE_SESSIONS_SHOWN = 5;

function SessionRow({ project, slot }: LiveSession) {
  return (
    <li>
      <Link
        href={slotHref(project.id, slot.name)}
        className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-hover"
      >
        {/* Identity is square; the pill carries the status (#213). */}
        <Badge shape="square" hue={projectHue(project.id)} aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">
            {slot.name}
            {slot.issue === null ? null : (
              <span className="num text-ink-3"> · #{slot.issue}</span>
            )}
          </span>
          <span className="truncate text-xs text-ink-3">
            {project.displayName} · {slot.runtime}
            {' · '}
            <Time value={slot.startedAt} />
          </span>
        </span>
        <StatusPill
          status={SLOT_PILL_STATUS[slot.status]}
          label={SLOT_STATUS_LABEL[slot.status]}
        />
      </Link>
    </li>
  );
}

/** Projects whose fleet did not answer: their sessions cannot be listed. */
function silentProjects(
  projects: ProjectSummary[],
  facts: ReturnType<typeof useDashboard>['facts'],
): ProjectSummary[] {
  if (!facts.data) return [];
  const { fleets } = facts.data;
  return projects.filter((project) => !fleets.has(project.id));
}

/** The agent sessions alive now, across every project, longest running first. */
export function LiveSessions({
  projects,
  facts,
}: {
  projects: ProjectSummary[];
  facts: ReturnType<typeof useDashboard>['facts'];
}) {
  const sessions = facts.data
    ? liveSessions(projects, facts.data.fleets)
    : undefined;
  const silent = silentProjects(projects, facts);
  const shown = sessions?.slice(0, LIVE_SESSIONS_SHOWN) ?? [];

  return (
    <Section
      title="Live sessions"
      description={
        sessions && sessions.length > 0
          ? `Showing ${shown.length} of ${sessions.length}, longest running first.`
          : undefined
      }
      pad="none"
      bodyClassName="px-2 py-1"
      actions={
        <Link href="/sessions" className="text-sm text-ink-2 hover:underline">
          All sessions
        </Link>
      }
    >
      {silent.length > 0 ? (
        <p className="px-2 pt-2 text-xs text-warn">
          {silent.map((p) => p.displayName).join(', ')}{' '}
          {silent.length === 1 ? 'is' : 'are'} not answering; any sessions it
          runs are not listed.
        </p>
      ) : null}
      {sessions ? (
        sessions.length > 0 ? (
          <ul className="flex flex-col">
            {shown.map(({ project, slot }) => (
              <SessionRow key={slot.id} project={project} slot={slot} />
            ))}
          </ul>
        ) : (
          <EmptyState
            title="Nothing is running"
            description="Agent sessions show up here as the orchestrators dispatch work."
          />
        )
      ) : facts.error !== null ? (
        <Retry title="Could not load live sessions" section={facts} />
      ) : (
        <Skeleton className="m-2 h-24" />
      )}
    </Section>
  );
}
