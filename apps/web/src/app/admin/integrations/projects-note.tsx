'use client';

import type { ProjectSummary } from '@agentdock/shared';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { DisabledReason } from '../../../components/prerequisites/disabled-reason';
import type { Section } from '../../../lib/section/use-section';

/**
 * Under a project picker in a trigger or webhook form: why it is empty. A
 * failed load is said as a failure with Try again (rule R2), never as "no
 * projects"; no projects at all links to where one is connected (rule R3).
 */
export function ProjectsNote({
  projects,
  id,
}: {
  projects: Section<ProjectSummary[]>;
  /** Point the picker's `aria-describedby` here. */
  id?: string;
}) {
  if (projects.data === undefined && projects.error !== null) {
    return (
      <Banner
        tone="danger"
        title="Projects could not be loaded"
        action={
          <Button
            variant="glass"
            size="sm"
            disabled={projects.loading}
            onClick={projects.retry}
          >
            Try again
          </Button>
        }
      />
    );
  }
  if (projects.data?.length === 0) {
    return (
      <DisabledReason id={id} href="/projects" cta="Connect a project">
        No projects yet.
      </DisabledReason>
    );
  }
  return null;
}
