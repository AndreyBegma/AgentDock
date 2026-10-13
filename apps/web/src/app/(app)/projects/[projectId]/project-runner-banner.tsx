'use client';

import { RunnerOfflineBanner } from '../../../../components/prerequisites/prerequisite-banner';
import { useProjectDetail } from './use-project-detail';

/**
 * Under the h1 of a project page: a banner while the project's runner cannot
 * be reached (rule R4), nothing otherwise. A page that already holds the
 * project renders `RunnerOfflineBanner` itself.
 */
export function ProjectRunnerBanner({ projectId }: { projectId: string }) {
  const { data: project } = useProjectDetail(projectId);
  return project ? <RunnerOfflineBanner project={project} /> : null;
}
