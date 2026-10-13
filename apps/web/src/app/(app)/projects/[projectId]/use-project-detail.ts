'use client';

import type { ProjectDetail } from '@agentdock/shared';
import { useEffect } from 'react';
import { api } from '../../../../lib/api';
import { useSection } from '../../../../lib/section/use-section';

/** A runner that comes back, or drops, should show on the page without a reload. */
const REFRESH_MS = 30_000;

/**
 * The project the page is about, with the runner that serves it. The data
 * stays on a failed refresh (rule R2), so a banner never flickers away.
 */
export function useProjectDetail(projectId: string) {
  const section = useSection(
    () => api<ProjectDetail>(`/projects/${projectId}`),
    [projectId],
  );
  const { retry } = section;
  useEffect(() => {
    const timer = setInterval(retry, REFRESH_MS);
    return () => clearInterval(timer);
  }, [retry]);
  return section;
}
