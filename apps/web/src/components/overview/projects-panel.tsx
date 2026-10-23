'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Section } from '@andrewbehma/glass-ui/section';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import type { ProjectSummary } from '@nautelle/shared';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { projectHue } from '../../lib/hue';
import { isAlive, orchestratorLabel } from '../../lib/overview/dashboard';
import { lastActivity } from '../../lib/projects/overview';
import { ORCHESTRATOR_PILL_STATUS } from '../../lib/status/pill';
import { costOrBlank, formatUsd } from '../../lib/usage/format';
import { Retry } from './shared';
import type { ProjectFacts, useDashboard } from './use-dashboard';

/** How many projects the glance shows before "All projects". */
const RECENT_PROJECTS = 8;

/** A project's Board: where every project card on the Workspace pages lands. */
export const boardHref = (projectId: string): string =>
  `/projects/${projectId}/board`;

/** A project's cost today: the figure, or a dash — never a false zero. */
function costToday(
  project: ProjectSummary,
  cost: ReturnType<typeof useDashboard>['costByProject'],
): ReactNode {
  if (!cost.data) {
    return cost.error !== null ? '—' : <Skeleton className="h-4 w-10" />;
  }
  const row = cost.data.rows.find((r) => r.key === project.id);
  if (!row) return formatUsd('0');
  return costOrBlank(row.costUsd, row.requests, row.unpricedRequests) || '—';
}

/** A project in the glance: one tap opens its Board. */
function ProjectRow({
  project,
  facts,
  needs,
  cost,
}: {
  project: ProjectSummary;
  facts: ProjectFacts | undefined;
  needs: number;
  cost: ReturnType<typeof useDashboard>['costByProject'];
}) {
  const fleet = facts?.fleets.get(project.id);
  const failed = facts?.failed.some((p) => p.id === project.id) ?? false;
  const live = fleet ? fleet.slots.filter(isAlive).length : null;

  return (
    <li>
      <Link
        href={boardHref(project.id)}
        aria-label={`Open the Board of ${project.displayName}`}
        className="flex min-w-0 flex-col gap-1 rounded-md px-2 py-2 hover:bg-hover"
      >
        <span className="flex items-center gap-2">
          {/* Identity is square; a round dot means status (#213). */}
          <Badge
            shape="square"
            hue={projectHue(project.id)}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">
            {project.displayName}
          </span>
          {fleet ? (
            <StatusPill
              status={ORCHESTRATOR_PILL_STATUS[fleet.orchestrator.status]}
              label={orchestratorLabel(fleet.orchestrator.status)}
            />
          ) : null}
        </span>
        <span className="num flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-6 text-xs text-ink-2">
          {fleet ? (
            <span>{live} live</span>
          ) : failed ? (
            <span className="text-warn">Not answering</span>
          ) : (
            <Skeleton className="h-4 w-12" />
          )}
          {facts ? (
            <span className={needs > 0 ? 'text-warn' : 'text-ink-3'}>
              {needs > 0 ? `${needs} need you` : 'Nothing waiting'}
            </span>
          ) : null}
          <span className="ml-auto text-ink-3">
            {costToday(project, cost)} today
          </span>
        </span>
      </Link>
    </li>
  );
}

/** Most recently active first; a project that has not answered keeps list order. */
function byRecentActivity(
  projects: ProjectSummary[],
  facts: ProjectFacts | undefined,
): ProjectSummary[] {
  const at = (p: ProjectSummary): number => {
    const fleet = facts?.fleets.get(p.id);
    const iso = fleet ? lastActivity(fleet) : null;
    return iso ? Date.parse(iso) : 0;
  };
  return [...projects].sort((a, b) => at(b) - at(a));
}

/** The most recently active projects, one tap to each Board. */
export function ProjectsPanel({
  projects,
  facts,
  needsByProject,
  costByProject,
}: {
  projects: ProjectSummary[];
  facts: ReturnType<typeof useDashboard>['facts'];
  needsByProject: Map<string, number>;
  costByProject: ReturnType<typeof useDashboard>['costByProject'];
}) {
  const recent = byRecentActivity(projects, facts.data).slice(
    0,
    RECENT_PROJECTS,
  );

  return (
    <Section
      title="Projects"
      pad="none"
      bodyClassName="px-2 py-1"
      actions={
        <Link href="/projects" className="text-sm text-ink-2 hover:underline">
          All projects
        </Link>
      }
    >
      {facts.error !== null && !facts.data ? (
        <Retry title="Project fleets are not answering" section={facts} />
      ) : null}
      <ul className="flex flex-col">
        {recent.map((project) => (
          <ProjectRow
            key={project.id}
            project={project}
            facts={facts.data}
            needs={needsByProject.get(project.id) ?? 0}
            cost={costByProject}
          />
        ))}
      </ul>
    </Section>
  );
}
