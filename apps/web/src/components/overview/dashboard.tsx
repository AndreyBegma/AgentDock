'use client';

import type { ProjectSummary } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { Section } from '@andrewbehma/glass-ui/section';
import { SectionUnavailable } from '@andrewbehma/glass-ui/section-unavailable';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { StatTile } from '@andrewbehma/glass-ui/stat-tile';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import {
  ArrowRight,
  CircleCheck,
  CircleX,
  GitPullRequest,
  MessageSquareWarning,
  OctagonAlert,
  Settings2,
} from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useState } from 'react';
import { pluralize } from '../../lib/format';
import { Time } from '../../lib/format/time';
import { projectHue } from '../../lib/hue';
import {
  isAlive,
  mergedPullRequests,
  mergedTodayHref,
  type NeedsYouItem,
  needsYou,
  OVERVIEW_TILE_HREF,
  orchestratorLabel,
  runningSlots,
} from '../../lib/overview/dashboard';
import { lastActivity } from '../../lib/projects/overview';
import type { Section as SectionState } from '../../lib/section/use-section';
import {
  type TerminalSetupNeed,
  terminalSetupNeeds,
} from '../../lib/setup/format';
import { ORCHESTRATOR_PILL_STATUS } from '../../lib/status/pill';
import { costOrBlank } from '../../lib/usage/format';
import type { ProjectFacts } from './use-dashboard';
import { useDashboard } from './use-dashboard';

/** How many projects and waiting items the glance shows before "All". */
const RECENT_PROJECTS = 6;
const NEEDS_YOU_SHOWN = 5;

/** A project's Board: where every project card on the Workspace pages lands. */
export const boardHref = (projectId: string): string =>
  `/projects/${projectId}/board`;

/** A tile's value: the figure, or a dash with the reason — never a false zero. */
function tileFigure<T>(
  section: SectionState<T>,
  figure: (data: T) => string,
): { value: ReactNode; failed: boolean } {
  if (section.data === undefined) {
    return { value: section.error !== null ? '—' : '', failed: true };
  }
  return {
    value: <span className="num">{figure(section.data)}</span>,
    failed: false,
  };
}

const notAnswering = (projects: ProjectSummary[]): string | undefined =>
  projects.length === 0
    ? undefined
    : projects.length === 1
      ? `${projects[0]?.displayName} is not answering`
      : `${projects.length} projects are not answering`;

function Stats({
  facts,
  costToday,
  merged,
}: Pick<ReturnType<typeof useDashboard>, 'facts' | 'costToday' | 'merged'>) {
  const running = tileFigure(facts, (f) =>
    String(runningSlots(f.fleets.values())),
  );
  const cost = tileFigure(
    costToday,
    (s) =>
      costOrBlank(
        s.totals.costUsd,
        s.totals.requests,
        s.totals.unpricedRequests,
      ) || '—',
  );
  const mergedToday = tileFigure(merged, (page) => {
    const count = mergedPullRequests(page.items);
    return page.nextCursor ? `${count}+` : String(count);
  });
  const partial = facts.data ? notAnswering(facts.data.failed) : undefined;

  return (
    <div className="grid grid-cols-1 gap-3 tablet:grid-cols-3">
      {/* Each tile goes where its figure is explained (#213). */}
      <StatTile
        hue={2}
        label="Running slots"
        loading={facts.loading && !facts.data}
        value={running.value}
        hint={
          facts.error !== null && !facts.data
            ? 'Projects are not answering'
            : (partial ?? 'Agent sessions alive now')
        }
        href={OVERVIEW_TILE_HREF.running}
      />
      <StatTile
        hue={4}
        label="Cost today"
        loading={costToday.loading && !costToday.data}
        value={cost.value}
        hint={
          cost.failed
            ? 'Usage is not answering'
            : 'API-equivalent, since midnight'
        }
        href={OVERVIEW_TILE_HREF.cost}
      />
      <StatTile
        hue={3}
        label="PRs merged today"
        loading={merged.loading && !merged.data}
        value={mergedToday.value}
        hint={
          mergedToday.failed ? 'Activity is not answering' : 'Since midnight'
        }
        href={mergedTodayHref()}
      />
    </div>
  );
}

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

const NEEDS_ICON: Record<NeedsYouItem['kind'], ReactNode> = {
  profile: <Settings2 aria-hidden="true" className="size-4 text-warn" />,
  failed: <CircleX aria-hidden="true" className="size-4 text-danger" />,
  blocked: <OctagonAlert aria-hidden="true" className="size-4 text-danger" />,
  prompt: (
    <MessageSquareWarning aria-hidden="true" className="size-4 text-warn" />
  ),
  approval: <GitPullRequest aria-hidden="true" className="size-4 text-ink-2" />,
};

function NeedsYou({
  items,
  setup,
}: {
  items: NeedsYouItem[];
  setup: TerminalSetupNeed[];
}) {
  if (items.length === 0 && setup.length === 0) {
    return (
      <p className="flex items-center gap-2 py-2 text-sm text-ink-2">
        <CircleCheck aria-hidden="true" className="size-4 text-ok" />
        Nothing is waiting on you.
      </p>
    );
  }
  return (
    <ul className="flex flex-col">
      {setup.map((need) => (
        <li key={need.key}>
          <Link
            href={need.href}
            className="flex items-start gap-3 rounded-md px-2 py-2 hover:bg-hover"
          >
            <span className="mt-0.5 shrink-0">{NEEDS_ICON.profile}</span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">{need.title}</span>
              <span className="truncate text-xs text-ink-3">
                {need.projectName} · {need.reason}
              </span>
            </span>
          </Link>
        </li>
      ))}
      {items.map((item) => (
        <li key={item.key}>
          <Link
            href={item.href}
            className="flex items-start gap-3 rounded-md px-2 py-2 hover:bg-hover"
          >
            <span className="mt-0.5 shrink-0">{NEEDS_ICON[item.kind]}</span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">{item.title}</span>
              <span className="truncate text-xs text-ink-3">
                {item.projectName} · {item.reason}
              </span>
            </span>
            {item.since ? (
              <Time
                value={item.since}
                className="shrink-0 text-xs whitespace-nowrap text-ink-3"
              />
            ) : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}
function Retry({
  title,
  section,
}: {
  title: string;
  section: Pick<SectionState<unknown>, 'retry' | 'loading'>;
}) {
  return (
    <SectionUnavailable
      title={title}
      action={
        <Button
          variant="glass"
          size="sm"
          onClick={section.retry}
          disabled={section.loading}
        >
          Try again
        </Button>
      }
    />
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

/** The Overview below Getting started: what waits on you, then recent projects. */
export function Dashboard({ projects }: { projects: ProjectSummary[] }) {
  const dashboard = useDashboard(projects);
  const { facts } = dashboard;
  const [showAll, setShowAll] = useState(false);
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
  const shown =
    waiting && !showAll ? waiting.slice(0, NEEDS_YOU_SHOWN) : waiting;
  const hidden = (waiting?.length ?? 0) - (shown?.length ?? 0);
  const recent = byRecentActivity(projects, facts.data).slice(
    0,
    RECENT_PROJECTS,
  );

  return (
    <div className="flex flex-col gap-6">
      <Stats {...dashboard} />

      <Section
        title="Needs you"
        description="Across every project, oldest first."
        pad="none"
        bodyClassName="px-2 py-1"
      >
        {shown ? (
          <>
            {facts.data && facts.data.failed.length > 0 ? (
              <p className="px-2 pt-2 text-xs text-warn">
                {notAnswering(facts.data.failed)}; what it waits on is not
                listed.
              </p>
            ) : null}
            <NeedsYou items={shown} setup={setup} />
            {hidden > 0 ? (
              <div className="px-2 pb-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowAll(true)}
                >
                  Show {hidden} more
                </Button>
              </div>
            ) : null}
          </>
        ) : facts.error !== null ? (
          <Retry title="Could not check what waits on you" section={facts} />
        ) : (
          <Skeleton className="m-2 h-24" />
        )}
      </Section>

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
    </div>
  );
}
