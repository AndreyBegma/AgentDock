'use client';

import type {
  ActivityItem,
  ActivitySeverity,
  ProjectSummary,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { SectionUnavailable } from '@andrewbehma/glass-ui/section-unavailable';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { Sparkline } from '@andrewbehma/glass-ui/sparkline';
import { StatTile } from '@andrewbehma/glass-ui/stat-tile';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import {
  ChevronRight,
  CircleCheck,
  CircleX,
  GitPullRequest,
  MessageSquareWarning,
  OctagonAlert,
  Settings2,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { activityHref, itemTitle } from '../../lib/activity/format';
import { formatCost, formatDate, pluralize } from '../../lib/format';
import { Time } from '../../lib/format/time';
import { projectHue } from '../../lib/hue';
import {
  approvalsHref,
  costByProject,
  isAlive,
  mergedPullRequests,
  mergedTodayHref,
  type NeedsYouItem,
  needsYou,
  OVERVIEW_TILE_HREF,
  orchestratorLabel,
  roundLabel,
  runningSlots,
  waitingApprovals,
} from '../../lib/overview/dashboard';
import { RUNNER_STATUS_LABEL, STATUS_TONE } from '../../lib/runners/format';
import type { Section } from '../../lib/section/use-section';
import {
  type TerminalSetupNeed,
  terminalSetupNeeds,
} from '../../lib/setup/format';
import { ORCHESTRATOR_PILL_STATUS } from '../../lib/status/pill';
import { costOrBlank, sparkValues } from '../../lib/usage/format';
import { DigestPanel } from '../steward/digest-panel';
import type { ProjectFacts } from './use-dashboard';
import { useDashboard } from './use-dashboard';

/** A tile's value: the figure, or a dash with the reason — never a false zero. */
function tileFigure<T>(
  section: Section<T>,
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
  projects,
  facts,
  costToday,
  merged,
}: Pick<ReturnType<typeof useDashboard>, 'facts' | 'costToday' | 'merged'> & {
  projects: ProjectSummary[];
}) {
  const running = tileFigure(facts, (f) =>
    String(runningSlots(f.fleets.values())),
  );
  const approvals = tileFigure(facts, (f) =>
    String(waitingApprovals(f.approvals.values())),
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
  const factsHint = (fine: string) =>
    facts.error !== null && !facts.data
      ? 'Projects are not answering'
      : (partial ?? fine);

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {/* Each tile keeps one hue, echoing the status it counts (#163):
          running teal, cost amber, merged green, waiting blue. Every tile
          goes where its figure is explained (#213). */}
      <StatTile
        hue={2}
        label="Running slots"
        loading={facts.loading && !facts.data}
        value={running.value}
        hint={factsHint('Agent sessions alive now')}
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
      <StatTile
        hue={1}
        label="Approvals waiting"
        loading={facts.loading && !facts.data}
        value={approvals.value}
        hint={factsHint('Pull requests waiting for a merge decision')}
        href={
          facts.data
            ? approvalsHref(projects, facts.data.approvals)
            : '/projects'
        }
      />
    </div>
  );
}

function ProjectCard({
  project,
  facts,
  costs,
}: {
  project: ProjectSummary;
  facts: ProjectFacts | undefined;
  costs: number[] | undefined;
}) {
  const fleet = facts?.fleets.get(project.id);
  const failed = facts?.failed.some((p) => p.id === project.id) ?? false;
  const live = fleet ? fleet.slots.filter(isAlive).length : null;
  const round = fleet
    ? roundLabel(fleet.latestRound, (iso) => formatDate(iso, 'day'))
    : null;
  const trend = costs ? sparkValues(costs) : null;
  const week = costs?.reduce((sum, c) => sum + c, 0);

  return (
    <Link
      href={`/projects/${project.id}`}
      className="group block rounded-surface"
    >
      {/* The project's identity hue, the same on every screen (#163). */}
      <Card
        pad="md"
        hue={projectHue(project.id)}
        className="flex h-full flex-col gap-3 transition-colors group-hover:bg-hover"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-2 font-semibold tracking-tight">
              {/* Identity is square; a round dot means status (#213). */}
              <Badge
                shape="square"
                hue={projectHue(project.id)}
                aria-hidden="true"
              />
              <span className="truncate">{project.displayName}</span>
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs text-ink-3">
              <Badge
                dot
                tone={STATUS_TONE[project.runnerStatus]}
                aria-hidden="true"
              />
              {project.runnerName} · {RUNNER_STATUS_LABEL[project.runnerStatus]}
            </span>
          </div>
          <ChevronRight
            aria-hidden="true"
            className="size-4 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          {fleet ? (
            <>
              <StatusPill
                status={ORCHESTRATOR_PILL_STATUS[fleet.orchestrator.status]}
                label={orchestratorLabel(fleet.orchestrator.status)}
              />
              <span className="num text-ink-2">
                {pluralize(live ?? 0, 'live slot')}
              </span>
            </>
          ) : failed ? (
            <span className="text-ink-3">Fleet is not answering</span>
          ) : (
            <Skeleton className="h-5 w-40" />
          )}
        </div>
        {round ? <p className="num text-xs text-ink-3">{round}</p> : null}

        <div className="mt-auto flex items-end justify-between gap-3 border-t border-line pt-3">
          <div className="flex flex-col">
            <span className="text-xs text-ink-3">Cost, 7 days</span>
            <span className="num text-sm font-medium">
              {week === undefined ? '—' : formatCost(week)}
            </span>
          </div>
          {trend ? (
            <div className="max-w-[50%] overflow-hidden">
              <Sparkline
                values={trend}
                width={112}
                height={28}
                area
                label={`${project.displayName}: cost per day, last 7 days`}
              />
            </div>
          ) : null}
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
    <ul className="-mx-2 flex flex-col">
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

const SEVERITY_TONE: Record<
  ActivitySeverity,
  'neutral' | 'ok' | 'warn' | 'danger'
> = { info: 'neutral', ok: 'ok', warn: 'warn', danger: 'danger' };

function RecentActivity({
  items,
  projects,
}: {
  items: ActivityItem[];
  projects: ProjectSummary[];
}) {
  if (items.length === 0) {
    return <p className="py-2 text-sm text-ink-2">No activity yet.</p>;
  }
  const names = new Map(projects.map((p) => [p.id, p.displayName]));
  return (
    <ul className="-mx-2 flex flex-col">
      {items.map((item) => {
        // A slot's row opens that slot on its Fleet (#213), and a PR's URL is
        // not part of the title — Activity's own rules, shared.
        const href = activityHref(item);
        const { title } = itemTitle(item);
        const body = (
          <>
            <Badge
              dot
              tone={SEVERITY_TONE[item.severity]}
              aria-hidden="true"
              className="mt-1.5 shrink-0"
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm">{title}</span>
              {item.projectId && names.has(item.projectId) ? (
                <span className="truncate text-xs text-ink-3">
                  {names.get(item.projectId)}
                  {item.slot ? ` · ${item.slot}` : ''}
                </span>
              ) : null}
            </span>
            <Time
              value={item.ts}
              className="shrink-0 text-xs whitespace-nowrap text-ink-3"
            />
          </>
        );
        const row = 'flex items-start gap-3 rounded-md px-2 py-2';
        return (
          <li key={item.id}>
            {href ? (
              <Link href={href} className={`${row} hover:bg-hover`}>
                {body}
              </Link>
            ) : (
              <div className={row}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card pad="md" className="flex min-w-0 flex-col gap-2">
      <SectionHeader title={title} {...(action ? { actions: action } : {})} />
      {children}
    </Card>
  );
}

function Retry({
  title,
  section,
}: {
  title: string;
  section: Pick<Section<unknown>, 'retry' | 'loading'>;
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

/** The Overview below Getting started: figures, projects, what waits on you, what happened. */
export function Dashboard({ projects }: { projects: ProjectSummary[] }) {
  const dashboard = useDashboard(projects);
  const { facts, cost7d, recent } = dashboard;
  const costs = cost7d.data ? costByProject(cost7d.data) : undefined;
  const waiting = facts.data
    ? needsYou(projects, facts.data.fleets, facts.data.approvals, {
        failedRuns: facts.data.failedRuns,
        missingProfile: facts.data.missingProfile,
      })
    : undefined;

  return (
    <div className="flex flex-col gap-6">
      <Stats projects={projects} {...dashboard} />

      <section
        aria-labelledby="overview-projects"
        className="flex flex-col gap-3"
      >
        <SectionHeader
          title="Projects"
          headingId="overview-projects"
          actions={
            <Link
              href="/projects"
              className="text-sm text-ink-2 hover:underline"
            >
              All projects
            </Link>
          }
        />
        {facts.error !== null && !facts.data ? (
          <Retry title="Project fleets are not answering" section={facts} />
        ) : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              facts={facts.data}
              costs={costs?.get(project.id) ?? (cost7d.data ? [] : undefined)}
            />
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Panel title="Needs you">
          {waiting ? (
            <>
              {facts.data && facts.data.failed.length > 0 ? (
                <p className="text-xs text-warn">
                  {notAnswering(facts.data.failed)}; what it waits on is not
                  listed.
                </p>
              ) : null}
              <NeedsYou
                items={waiting}
                setup={terminalSetupNeeds(
                  projects,
                  facts.data?.terminalSetup ?? new Map(),
                )}
              />
            </>
          ) : facts.error !== null ? (
            <Retry title="Could not check what waits on you" section={facts} />
          ) : (
            <Skeleton className="h-24 w-full" />
          )}
        </Panel>
        <Panel
          title="Recent activity"
          action={
            <Link
              href="/activity"
              className="text-sm text-ink-2 hover:underline"
            >
              All activity
            </Link>
          }
        >
          {recent.data ? (
            <RecentActivity items={recent.data.items} projects={projects} />
          ) : recent.error !== null ? (
            <Retry title="Activity is not answering" section={recent} />
          ) : (
            <Skeleton className="h-24 w-full" />
          )}
        </Panel>
      </div>

      <DigestPanel projects={projects} />
    </div>
  );
}
