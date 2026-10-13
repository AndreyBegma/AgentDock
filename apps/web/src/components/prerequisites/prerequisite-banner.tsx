'use client';

import type { ProjectSummary } from '@agentdock/shared';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { buttonClassName } from '@andrewbehma/glass-ui/button';
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  type PrerequisiteCopy,
  runnerOfflineCopy,
} from '../../lib/prerequisites/copy';
import { InstallGuideLink } from '../onboarding/runner-commands';
import { useCurrentUser } from '../shell/user-context';

/**
 * Rule R4: something this page depends on is missing. Names it, says what it
 * blocks, and links to the page that fixes it.
 */
export function PrerequisiteBanner({
  tone,
  title,
  body,
  href,
  cta,
}: Omit<PrerequisiteCopy, 'body'> & { body: ReactNode }) {
  return (
    <Banner
      tone={tone}
      title={title}
      action={
        href && cta ? (
          <Link
            href={href}
            className={buttonClassName({ variant: 'glass', size: 'sm' })}
          >
            {cta}
          </Link>
        ) : undefined
      }
    >
      {body}
    </Banner>
  );
}

/** Under a project page's h1: nothing while the project's runner is online. */
export function RunnerOfflineBanner({
  project,
}: {
  project: Pick<ProjectSummary, 'runnerName' | 'runnerStatus'>;
}) {
  const isAdmin = useCurrentUser().role === 'admin';
  const copy = runnerOfflineCopy(project, isAdmin);
  if (!copy) return null;
  return (
    <PrerequisiteBanner
      {...copy}
      body={
        <>
          {copy.body}
          <InstallGuideLink>How to start the runner</InstallGuideLink>
        </>
      }
    />
  );
}
