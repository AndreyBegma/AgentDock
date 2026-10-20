'use client';

import type { ProjectSummary } from '@agentdock/shared';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { buttonClassName } from '@andrewbehma/glass-ui/button';
import { CodeBlock } from '@andrewbehma/glass-ui/code-block';
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  type PrerequisiteCopy,
  runnerOfflineCopy,
  watchRefusalCopy,
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

/**
 * Under a project page's h1: the runner is offline, or (#691) online but its
 * local policy refuses to watch the project; nothing otherwise.
 */
export function RunnerOfflineBanner({
  project,
}: {
  project: Pick<ProjectSummary, 'runnerName' | 'runnerStatus'> &
    Partial<Pick<ProjectSummary, 'watchRefusal'>>;
}) {
  const isAdmin = useCurrentUser().role === 'admin';
  const copy = runnerOfflineCopy(project, isAdmin);
  if (!copy) return <WatchRefusalBanner project={project} />;
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

/**
 * #691: the runner's local policy refuses to watch the project (ADR-0047).
 * Says why and shows the exact command to run on the runner's machine.
 */
export function WatchRefusalBanner({
  project,
}: {
  project: Pick<ProjectSummary, 'runnerName' | 'runnerStatus'> &
    Partial<Pick<ProjectSummary, 'watchRefusal'>>;
}) {
  const copy = watchRefusalCopy(project);
  if (!copy) return null;
  return (
    <PrerequisiteBanner
      {...copy}
      body={
        <>
          <p>{copy.body}</p>
          {copy.commands.map((command) => (
            <CodeBlock key={command} code={command} language="sh" />
          ))}
        </>
      }
    />
  );
}
