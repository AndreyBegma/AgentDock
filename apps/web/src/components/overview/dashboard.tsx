'use client';

import type { ProjectSummary } from '@nautelle/shared';
import { needsYou } from '../../lib/overview/dashboard';
import { terminalSetupNeeds } from '../../lib/setup/format';
import { LiveSessions } from './live-sessions';
import { NeedsYou } from './needs-you';
import { ProjectsPanel } from './projects-panel';
import { RecentActivity } from './recent-activity';
import { SpendTrend } from './spend-trend';
import { StatsStrip } from './stats-strip';
import { useDashboard } from './use-dashboard';

/** The Overview below Getting started: a stats strip over two columns. */
export function Dashboard({ projects }: { projects: ProjectSummary[] }) {
  const dashboard = useDashboard(projects);
  const { facts } = dashboard;
  const waiting = facts.data
    ? needsYou(projects, facts.data.fleets, facts.data.approvals, {
        failedRuns: facts.data.failedRuns,
        missingProfile: facts.data.missingProfile,
      })
    : undefined;
  const setup = terminalSetupNeeds(
    projects,
    facts.data?.terminalSetup ?? new Map(),
  );
  const needsByProject = new Map<string, number>();
  for (const item of waiting ?? []) {
    needsByProject.set(
      item.projectId,
      (needsByProject.get(item.projectId) ?? 0) + 1,
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <StatsStrip {...dashboard} />
      <div className="grid grid-cols-1 items-start gap-6 desktop:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <NeedsYou facts={facts} waiting={waiting} setup={setup} />
          <LiveSessions projects={projects} facts={facts} />
          <RecentActivity />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <ProjectsPanel
            projects={projects}
            facts={facts}
            needsByProject={needsByProject}
          />
          <SpendTrend />
        </div>
      </div>
    </div>
  );
}
