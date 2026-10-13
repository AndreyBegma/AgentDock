'use client';

import type { ProjectSummary } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import { toast } from '@andrewbehma/glass-ui/toast';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AsyncSection } from '../../../components/prerequisites/async-section';
import { useCurrentUser } from '../../../components/shell/user-context';
import { api } from '../../../lib/api';
import { RUNNERS_PAGE } from '../../../lib/prerequisites/copy';
import { usePrerequisites } from '../../../lib/prerequisites/use-prerequisites';
import { docsKindLabel } from '../../../lib/projects/format';
import { RUNNER_STATUS_LABEL, STATUS_TONE } from '../../../lib/runners/format';
import { useSection } from '../../../lib/section/use-section';
import { ConnectDialog } from './connect-dialog';

/** Like /admin/runners: the page polls; project events are not published yet. */
const POLL_MS = 15_000;

/** `/projects?connect=1` opens the Connect dialog (the pairing dialog links here). */
const CONNECT_PARAM = 'connect';

function ProjectsTable({ projects }: { projects: ProjectSummary[] }) {
  return (
    <Table scroll>
      <TableHead>
        <TableRow>
          <TableCell head>Name</TableCell>
          <TableCell head>Repository</TableCell>
          <TableCell head>Runner</TableCell>
          <TableCell head>Base</TableCell>
          <TableCell head>Docs</TableCell>
          <TableCell head>Your role</TableCell>
        </TableRow>
      </TableHead>
      <tbody>
        {projects.map((project) => (
          <TableRow key={project.id}>
            <TableCell>
              <Link
                href={`/projects/${project.id}`}
                className="font-medium underline-offset-4 hover:underline"
              >
                {project.displayName}
              </Link>
            </TableCell>
            <TableCell>{project.repo}</TableCell>
            <TableCell>
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
            </TableCell>
            <TableCell>{project.base}</TableCell>
            <TableCell>{docsKindLabel(project.docsKind)}</TableCell>
            <TableCell>{project.role}</TableCell>
          </TableRow>
        ))}
      </tbody>
    </Table>
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
        <Button variant="solid" size="sm" onClick={() => setConnecting(true)}>
          Connect project
        </Button>
      }
    />
  );

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Projects</h1>
          <p className="text-sm text-ink-2">
            Repositories on your runners that AgentDock can drive agents on.
          </p>
        </div>
        {isAdmin ? (
          <Button variant="solid" onClick={() => setConnecting(true)}>
            Connect project
          </Button>
        ) : null}
      </div>

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
