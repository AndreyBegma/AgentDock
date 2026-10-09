'use client';

import type { ProjectSummary } from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Button } from 'glass-ui/button';
import { EmptyState } from 'glass-ui/empty-state';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { toast } from 'glass-ui/toast';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useCurrentUser } from '../../../components/shell/user-context';
import { api } from '../../../lib/api';
import {
  describeProjectError,
  docsKindLabel,
} from '../../../lib/projects/format';
import { STATUS_TONE } from '../../../lib/runners/format';
import { ConnectDialog } from './connect-dialog';

/** Like /admin/runners: the page polls; project events are not published yet. */
const POLL_MS = 15_000;

export default function ProjectsPage() {
  const user = useCurrentUser();
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectSummary[]>();
  const [connecting, setConnecting] = useState(false);

  const load = useCallback(async () => {
    try {
      setProjects(await api<ProjectSummary[]>('/projects'));
    } catch (err) {
      toast.error(describeProjectError(err));
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const isAdmin = user.role === 'admin';

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Projects</h1>
        {isAdmin ? (
          <Button variant="solid" onClick={() => setConnecting(true)}>
            Connect project
          </Button>
        ) : null}
      </div>

      {projects && projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description={
            isAdmin
              ? 'Connect a git repository that lives on a paired runner.'
              : 'You are not a member of any project. Ask an administrator to add you.'
          }
        />
      ) : (
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
            {(projects ?? []).map((project) => (
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
                    <span className="sr-only">({project.runnerStatus})</span>
                  </span>
                </TableCell>
                <TableCell>{project.base}</TableCell>
                <TableCell>{docsKindLabel(project.docsKind)}</TableCell>
                <TableCell>{project.role}</TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      )}

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
