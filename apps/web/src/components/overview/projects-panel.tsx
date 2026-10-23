'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Card } from '@andrewbehma/glass-ui/card';
import { Section } from '@andrewbehma/glass-ui/section';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import type { ProjectSummary } from '@nautelle/shared';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { pluralize } from '../../lib/format';
import { projectHue } from '../../lib/hue';
import { isAlive, orchestratorLabel } from '../../lib/overview/dashboard';
import { lastActivity } from '../../lib/projects/overview';
import { ORCHESTRATOR_PILL_STATUS } from '../../lib/status/pill';
import { Retry } from './shared';
import type { ProjectFacts, useDashboard } from './use-dashboard';

/** How many projects the glance shows before "All projects". */
const RECENT_PROJECTS = 6;

/** A project's Board: where every project card on the Workspace pages lands. */
export const boardHref = (projectId: string): string =>
  `/projects/${projectId}/board`;

/** A recent project: one tap opens its Board. */
function ProjectCard({
  project,
  facts,
  needs,
}: {
  project: ProjectSummary;
  facts: ProjectFacts | undefined;
  needs: number;
}) {
  const fleet = facts?.fleets.get(project.id);
  const failed = facts?.failed.some((p) => p.id === project.id) ?? false;
  const live = fleet ? fleet.slots.filter(isAlive).length : null;

  return (
    <Link
      href={boardHref(project.id)}
      aria-label={`Open the Board of ${project.displayName}`}
      className="group block min-w-0 rounded-surface"
    >
      <Card
        pad="md"
        hue={projectHue(project.id)}
        className="flex h-full flex-col gap-3 transition-colors group-hover:bg-hover"
      >
        <div className="flex items-center gap-2">
          {/* Identity is square; a round dot means status (#213). */}
          <Badge
            shape="square"
            hue={projectHue(project.id)}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate font-semibold tracking-tight">
            {project.displayName}
          </span>
          {fleet ? (
            <StatusPill
              status={ORCHESTRATOR_PILL_STATUS[fleet.orchestrator.status]}
              label={orchestratorLabel(fleet.orchestrator.status)}
            />
          ) : null}
        </div>
        <p className="num text-sm text-ink-2">
          {fleet ? (
            pluralize(live ?? 0, 'live slot')
          ) : failed ? (
            <span className="text-ink-3">Fleet is not answering</span>
          ) : (
            <Skeleton className="h-5 w-32" />
          )}
        </p>
        <div className="mt-auto flex items-center gap-2 border-t border-line pt-3 text-sm">
          <span className={needs > 0 ? 'text-warn' : 'text-ink-3'}>
            {needs > 0 ? `${needs} need you` : 'Nothing waiting'}
          </span>
          <span className="flex-1" />
          <span className="inline-flex items-center gap-1 font-medium text-accent-ink">
            Open Board
            <ArrowRight
              aria-hidden="true"
              className="size-4 transition-transform group-hover:translate-x-0.5"
            />
          </span>
        </div>
      </Card>
    </Link>
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
}: {
  projects: ProjectSummary[];
  facts: ReturnType<typeof useDashboard>['facts'];
  needsByProject: Map<string, number>;
}) {
  const recent = byRecentActivity(projects, facts.data).slice(
    0,
    RECENT_PROJECTS,
  );

  return (
    <Section
      title="Recent projects"
      surface="none"
      actions={
        <Link href="/projects" className="text-sm text-ink-2 hover:underline">
          All projects
        </Link>
      }
    >
      {facts.error !== null && !facts.data ? (
        <Retry title="Project fleets are not answering" section={facts} />
      ) : null}
      <div className="grid grid-cols-1 gap-3 tablet:grid-cols-2 desktop:grid-cols-3">
        {recent.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            facts={facts.data}
            needs={needsByProject.get(project.id) ?? 0}
          />
        ))}
      </div>
    </Section>
  );
}
