'use client';

import type { FleetView, ProjectSummary } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { SearchField } from '@andrewbehma/glass-ui/field';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { toast } from '@andrewbehma/glass-ui/toast';
import { Toolbar } from '@andrewbehma/glass-ui/toolbar';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PageHeader } from '../../../components/page-header/page-header';
import { AsyncSection } from '../../../components/prerequisites/async-section';
import { useCurrentUser } from '../../../components/shell/user-context';
import { api } from '../../../lib/api';
import { ORCHESTRATOR_STATUS_LABEL } from '../../../lib/fleet/format';
import { pluralize } from '../../../lib/format';
import { projectHue } from '../../../lib/hue';
import { RUNNERS_PAGE } from '../../../lib/prerequisites/copy';
import { usePrerequisites } from '../../../lib/prerequisites/use-prerequisites';
import { RUNNER_STATUS_LABEL, STATUS_TONE } from '../../../lib/runners/format';
import { useSection } from '../../../lib/section/use-section';
import { ORCHESTRATOR_PILL_STATUS } from '../../../lib/status/pill';
import { ConnectDialog } from './connect-dialog';
import { type Fact, useProjectFacts } from './use-project-facts';

/** Like /admin/runners: the page polls; project events are not published yet. */
const POLL_MS = 15_000;

/** `/projects?connect=1` opens the Connect dialog (the pairing dialog links here). */
const CONNECT_PARAM = 'connect';

/** Fleet figures that have not loaded or did not answer. */
const factText = (fleet: Fact<FleetView>, text: (f: FleetView) => string) =>
  fleet ? text(fleet) : fleet === undefined ? '…' : '—';

function ProjectCard({
  project,
  fleet,
}: {
  project: ProjectSummary;
  fleet: Fact<FleetView>;
}) {
  return (
    <Link
      href={`/projects/${project.id}/board`}
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
              label={ORCHESTRATOR_STATUS_LABEL[fleet.orchestrator.status]}
            />
          ) : null}
        </div>
        <p className="truncate font-mono text-sm text-ink-2">{project.repo}</p>
        <p className="inline-flex items-center gap-1.5 text-xs text-ink-3">
          <Badge
            dot
            tone={STATUS_TONE[project.runnerStatus]}
            aria-hidden="true"
          />
          {project.runnerName} · {RUNNER_STATUS_LABEL[project.runnerStatus]}
        </p>
        <div className="mt-auto flex items-center gap-2 border-t border-line pt-3 text-sm">
          <span className="num text-ink-2">
            {factText(fleet, (f) => pluralize(f.slots.length, 'slot'))}
          </span>
          <span className="flex-1" />
          <span className="inline-flex items-center gap-1 font-medium text-accent-ink">
            Board
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

function ProjectsGrid({ projects }: { projects: ProjectSummary[] }) {
  const { fleets } = useProjectFacts(projects.map((p) => p.id));
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? projects.filter((p) =>
        `${p.displayName} ${p.repo}`.toLowerCase().includes(needle),
      )
    : projects;

  return (
    <div className="flex flex-col gap-4">
      <Toolbar
        aria-label="Filter projects"
        filters={
          <SearchField
            aria-label="Search projects"
            placeholder="Search projects"
            value={query}
            className="w-full tablet:w-64"
            onChange={(e) => setQuery(e.target.value)}
          />
        }
      />
      {shown.length === 0 ? (
        <EmptyState
          title="No project matches"
          description="Try the repository name, or clear the search."
          action={{ label: 'Clear search', onClick: () => setQuery('') }}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 tablet:grid-cols-2 desktop:grid-cols-3">
          {shown.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              fleet={fleets[project.id]}
            />
          ))}
        </div>
      )}
    </div>
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
        eyebrow="Workspace"
        title="Projects"
        description="Repositories this control plane runs agents for."
        // With no project and no runner, "Pair a runner" below is the next
        // step and the one solid; Connect would only say so (#213).
        {...(isAdmin
          ? noOnlineRunner && projects.data?.length === 0
            ? {
                actions: (
                  <Button variant="glass" onClick={() => setConnecting(true)}>
                    Connect project
                  </Button>
                ),
              }
            : {
                primaryAction: {
                  label: 'Connect project',
                  onClick: () => setConnecting(true),
                },
              }
          : {})}
      />

      <AsyncSection
        section={projects}
        unavailable={{ title: 'Projects are not answering' }}
        empty={empty}
      >
        {(list) => <ProjectsGrid projects={list} />}
      </AsyncSection>

      {isAdmin ? (
        <ConnectDialog
          open={connecting}
          onClose={() => setConnecting(false)}
          onConnected={(project) => {
            setConnecting(false);
            toast.success(`${project.displayName} connected.`);
            router.push(`/projects/${project.id}/board`);
          }}
        />
      ) : null}
    </>
  );
}
