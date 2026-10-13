'use client';

import type { ProjectSummary } from '@agentdock/shared';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { SectionUnavailable } from '@andrewbehma/glass-ui/section-unavailable';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import Link from 'next/link';
import { useEffect } from 'react';
import { GettingStarted } from '../../components/onboarding/getting-started';
import {
  CONNECT_PATH,
  gettingStarted,
} from '../../components/onboarding/steps';
import { Dashboard } from '../../components/overview/dashboard';
import { PageHeader } from '../../components/page-header/page-header';
import { AsyncSection } from '../../components/prerequisites/async-section';
import { useCurrentUser } from '../../components/shell/user-context';
import { api } from '../../lib/api';
import { usePrerequisites } from '../../lib/prerequisites/use-prerequisites';
import { useSection } from '../../lib/section/use-section';

/** While the checklist is open, the admin is usually pairing on another screen. */
const SETUP_POLL_MS = 15_000;

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
      <PageHeader
        className="mb-0"
        title="Overview"
        description="What your fleet is doing now, and what waits on you."
      />

      {isAdmin && runners.state === 'loading' ? (
        <Skeleton className="h-48 w-full" />
      ) : null}
      {isAdmin && runners.state === 'error' ? (
        <SectionUnavailable
          title="Could not check the runners for Getting started"
          stillWorks="The dashboard below still works."
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

      <AsyncSection
        section={projects}
        unavailable={{ title: 'Projects are not answering' }}
        skeleton={
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {['a', 'b', 'c', 'd'].map((key) => (
              <Skeleton key={key} className="h-28 w-full" />
            ))}
          </div>
        }
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
        {(list) => <Dashboard projects={list} />}
      </AsyncSection>
    </div>
  );
}
