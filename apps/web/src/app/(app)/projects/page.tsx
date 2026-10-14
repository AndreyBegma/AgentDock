'use client';

import type { ProjectSummary } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { type Column, DataTable } from '@andrewbehma/glass-ui/data-table';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Sparkline } from '@andrewbehma/glass-ui/sparkline';
import { StatusDot } from '@andrewbehma/glass-ui/status-pill';
import { toast } from '@andrewbehma/glass-ui/toast';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../../../components/page-header/page-header';
import { AsyncSection } from '../../../components/prerequisites/async-section';
import { ScrollX } from '../../../components/scroll-x/scroll-x';
import { useCurrentUser } from '../../../components/shell/user-context';
import { api } from '../../../lib/api';
import { ORCHESTRATOR_STATUS_LABEL } from '../../../lib/fleet/format';
import { formatCost, formatNumber } from '../../../lib/format';
import { Time } from '../../../lib/format/time';
import { projectHue } from '../../../lib/hue';
import { RUNNERS_PAGE } from '../../../lib/prerequisites/copy';
import { usePrerequisites } from '../../../lib/prerequisites/use-prerequisites';
import {
  COST_DAYS,
  costTrend,
  hasTrend,
  lastActivity,
  lastDays,
} from '../../../lib/projects/overview';
import { RUNNER_STATUS_LABEL, STATUS_TONE } from '../../../lib/runners/format';
import { useSection } from '../../../lib/section/use-section';
import { ORCHESTRATOR_PILL_STATUS } from '../../../lib/status/pill';
import { ConnectDialog } from './connect-dialog';
import { useProjectFacts } from './use-project-facts';

/** Like /admin/runners: the page polls; project events are not published yet. */
const POLL_MS = 15_000;

/** `/projects?connect=1` opens the Connect dialog (the pairing dialog links here). */
const CONNECT_PARAM = 'connect';

const DASH = <span className="text-ink-3">—</span>;

function ProjectsTable({ projects }: { projects: ProjectSummary[] }) {
  const router = useRouter();
  const { fleets, cost } = useProjectFacts(projects.map((p) => p.id));
  const days = useMemo(() => lastDays(Date.now()), []);

  const columns = useMemo<Column<ProjectSummary>[]>(
    () => [
      {
        id: 'name',
        header: 'Project',
        cell: (project) => (
          <span className="flex items-start gap-2">
            {/* The project's identity hue, as on its Overview card (#163):
                a square swatch, since a round dot means status (#213). */}
            <Badge
              shape="square"
              hue={projectHue(project.id)}
              aria-hidden="true"
              className="mt-1.5"
            />
            <span className="min-w-0">
              <Link
                href={`/projects/${project.id}`}
                className="font-medium underline-offset-4 hover:underline"
              >
                {project.displayName}
              </Link>
              <span className="block text-xs text-ink-3">{project.repo}</span>
            </span>
          </span>
        ),
      },
      {
        id: 'runner',
        header: 'Runner',
        cell: (project) => (
          <span className="inline-flex items-center gap-2">
            <Badge
              dot
              tone={STATUS_TONE[project.runnerStatus]}
              aria-hidden="true"
            />
            {project.runnerName}
            <span className="sr-only">
              ({RUNNER_STATUS_LABEL[project.runnerStatus]})
            </span>
          </span>
        ),
      },
      {
        id: 'orchestrator',
        header: 'Orchestrator',
        cell: (project) => {
          const fleet = fleets[project.id];
          if (!fleet) return fleet === undefined ? '…' : DASH;
          const status = fleet.orchestrator.status;
          return (
            <span className="inline-flex items-center gap-2">
              <StatusDot status={ORCHESTRATOR_PILL_STATUS[status]} />
              {ORCHESTRATOR_STATUS_LABEL[status]}
            </span>
          );
        },
      },
      {
        id: 'slots',
        header: 'Slots',
        align: 'end',
        cell: (project) => {
          const fleet = fleets[project.id];
          if (!fleet) return fleet === undefined ? '…' : DASH;
          return (
            <span className="num">{formatNumber(fleet.slots.length)}</span>
          );
        },
      },
      {
        id: 'activity',
        header: 'Last activity',
        cell: (project) => {
          const fleet = fleets[project.id];
          if (!fleet) return fleet === undefined ? '…' : DASH;
          const at = lastActivity(fleet);
          return at ? <Time value={at} /> : DASH;
        },
      },
      {
        id: 'cost',
        header: '7-day cost',
        align: 'end',
        cell: (project) => {
          if (!cost) return cost === undefined ? '…' : DASH;
          const trend = costTrend(cost, project.id, days);
          return (
            <span className="inline-flex items-center justify-end gap-2">
              {hasTrend(trend) ? (
                <Sparkline
                  values={trend.values}
                  width={64}
                  height={20}
                  label={`Daily cost over the last ${COST_DAYS} days`}
                />
              ) : null}
              <span className="num">{formatCost(trend.total)}</span>
            </span>
          );
        },
      },
      { id: 'role', header: 'Your role', cell: (project) => project.role },
    ],
    [fleets, cost, days],
  );

  return (
    <ScrollX label="Projects">
      <DataTable
        rows={projects}
        getRowId={(project) => project.id}
        columns={columns}
        onRowActivate={(project) => router.push(`/projects/${project.id}`)}
      />
    </ScrollX>
  );
}

export default function ProjectsPage() {
  const isAdmin = useCurrentUser().role === 'admin';
  const router = useRouter();
  const pathname = usePathname();
  const [connecting, setConnecting] = useState(false);
  const projects = useSection(() => api<ProjectSummary[]>('/projects'), []);
  const { runners } = usePrerequisites({ runners: isAdmin });

  const { retry } = projects;
  useEffect(() => {
    const timer = setInterval(retry, POLL_MS);
    return () => clearInterval(timer);
  }, [retry]);

  // Read once on mount, then dropped so a reload does not reopen the dialog.
  useEffect(() => {
    if (!isAdmin) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get(CONNECT_PARAM) === null) return;
    setConnecting(true);
    params.delete(CONNECT_PARAM);
    const rest = params.toString();
    router.replace(rest ? `${pathname}?${rest}` : pathname);
  }, [isAdmin, pathname, router]);

  // Until the fact loads, offer Connect: the dialog itself says what is missing.
  const noOnlineRunner =
    runners.state === 'ready' &&
    (runners.value.kind === 'none' || runners.value.kind === 'offline');

  const empty = !isAdmin ? (
    <EmptyState
      title="No projects yet"
      description="You are not a member of any project. Ask an administrator to add you to a project."
    />
  ) : noOnlineRunner ? (
    <EmptyState
      title="No projects yet"
      description="Projects live on a runner, the AgentDock daemon on the machine that holds your repositories. Pair one first."
      action={
        <Link
          href={RUNNERS_PAGE}
          className={buttonClassName({ variant: 'solid', size: 'sm' })}
        >
          Pair a runner
        </Link>
      }
    />
  ) : (
    <EmptyState
      title="No projects yet"
      description="A project is a GitHub repository cloned on a paired runner. Connect one to start driving agents on it."
      action={
        // Glass: the header's Connect project is the page's one solid (#213).
        <Button variant="glass" size="sm" onClick={() => setConnecting(true)}>
          Connect project
        </Button>
      }
    />
  );

  return (
    <>
      <PageHeader
        title="Projects"
        description="Repositories on your runners that AgentDock can drive agents on."
        actions={
          isAdmin ? (
            // With no project and no runner, "Pair a runner" below is the
            // next step and the one solid; Connect would only say so (#213).
            <Button
              variant={
                noOnlineRunner && projects.data?.length === 0
                  ? 'glass'
                  : 'solid'
              }
              onClick={() => setConnecting(true)}
            >
              Connect project
            </Button>
          ) : undefined
        }
      />

      <AsyncSection
        section={projects}
        unavailable={{ title: 'Projects are not answering' }}
        empty={empty}
      >
        {(list) => <ProjectsTable projects={list} />}
      </AsyncSection>

      {isAdmin ? (
        <ConnectDialog
          open={connecting}
          onClose={() => setConnecting(false)}
          onConnected={(project) => {
            setConnecting(false);
            toast.success(`${project.displayName} connected.`);
            router.push(`/projects/${project.id}`);
          }}
        />
      ) : null}
    </>
  );
}
