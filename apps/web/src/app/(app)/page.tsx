'use client';

import type { ProjectSummary } from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Button, buttonClassName } from 'glass-ui/button';
import { Card } from 'glass-ui/card';
import { EmptyState } from 'glass-ui/empty-state';
import { SectionUnavailable } from 'glass-ui/section-unavailable';
import { Skeleton } from 'glass-ui/skeleton';
import Link from 'next/link';
import { useEffect } from 'react';
import { GettingStarted } from '../../components/onboarding/getting-started';
import {
  CONNECT_PATH,
  gettingStarted,
} from '../../components/onboarding/steps';
import { AsyncSection } from '../../components/prerequisites/async-section';
import { useCurrentUser } from '../../components/shell/user-context';
import { api } from '../../lib/api';
import { usePrerequisites } from '../../lib/prerequisites/use-prerequisites';
import { RUNNER_STATUS_LABEL, STATUS_TONE } from '../../lib/runners/format';
import { useSection } from '../../lib/section/use-section';

/** While the checklist is open, the admin is usually pairing on another screen. */
const SETUP_POLL_MS = 15_000;

function ProjectList({ projects }: { projects: ProjectSummary[] }) {
  return (
    <ul className="flex flex-col divide-y divide-line">
      {projects.map((project) => (
        <li
          key={project.id}
          className="flex flex-wrap items-center justify-between gap-2 py-2"
        >
          <Link
            href={`/projects/${project.id}`}
            className="font-medium underline-offset-4 hover:underline"
          >
            {project.displayName}
          </Link>
          <span className="inline-flex items-center gap-2 text-sm text-ink-2">
            <Badge
              dot
              tone={STATUS_TONE[project.runnerStatus]}
              aria-hidden="true"
            />
            {project.runnerName} · {RUNNER_STATUS_LABEL[project.runnerStatus]}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function OverviewPage() {
  const isAdmin = useCurrentUser().role === 'admin';
  const projects = useSection(() => api<ProjectSummary[]>('/projects'), []);
  const { runners, reload } = usePrerequisites({ runners: isAdmin });

  const setup =
    isAdmin && runners.state === 'ready' && projects.data !== undefined
      ? gettingStarted({
          runners: runners.value,
          projects: projects.data.length,
        })
      : undefined;
  const settingUp = isAdmin && setup?.complete !== true;

  // Steps finish elsewhere (Runners, a terminal): look again until they are done.
  const { retry } = projects;
  useEffect(() => {
    if (!settingUp) return;
    const timer = setInterval(() => {
      reload();
      retry();
    }, SETUP_POLL_MS);
    return () => clearInterval(timer);
  }, [settingUp, reload, retry]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold">Overview</h1>
        <p className="text-sm text-ink-2">
          Your projects and the runners they live on.
        </p>
      </div>

      {isAdmin && runners.state === 'loading' ? (
        <Skeleton className="h-48 w-full" />
      ) : null}
      {isAdmin && runners.state === 'error' ? (
        <SectionUnavailable
          title="Could not check the runners for Getting started"
          stillWorks="Your projects below still work."
          action={
            <Button variant="glass" size="sm" onClick={reload}>
              Try again
            </Button>
          }
        />
      ) : null}
      {setup && !setup.complete && runners.state === 'ready' ? (
        <GettingStarted state={setup} runners={runners.value} />
      ) : null}

      <Card pad="lg" className="flex flex-col gap-3">
        <h2 className="text-lg font-bold">Projects</h2>
        <AsyncSection
          section={projects}
          unavailable={{ title: 'Projects are not answering' }}
          empty={
            isAdmin ? (
              <EmptyState
                title="No projects yet"
                description="A project is a GitHub repository cloned on a paired runner."
                action={
                  <Link
                    href={CONNECT_PATH}
                    className={buttonClassName({
                      variant: 'glass',
                      size: 'sm',
                    })}
                  >
                    Connect project
                  </Link>
                }
              />
            ) : (
              <EmptyState
                title="No projects yet"
                description="Ask an administrator to add you to a project."
              />
            )
          }
        >
          {(list) => <ProjectList projects={list} />}
        </AsyncSection>
      </Card>
    </div>
  );
}
