'use client';

import type { ProjectSummary } from '@agentdock/shared';
import { Combobox } from 'glass-ui/combobox';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

/**
 * Project switcher (spec 10 D3): the projects the caller may see, from
 * `GET /api/projects`. Renders nothing while the list is empty or unavailable.
 */
export function ProjectSwitcher({ projectId }: { projectId: string | null }) {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    api<ProjectSummary[]>('/projects')
      .then((list) => {
        if (!cancelled && Array.isArray(list)) setProjects(list);
      })
      .catch(() => {
        // No switcher; the Projects page still works.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (projects.length === 0) return null;

  return (
    <Combobox
      options={projects.map((project) => ({
        value: project.id,
        label: project.displayName,
      }))}
      value={projectId}
      onValueChange={(id) => {
        if (id) router.push(`/projects/${id}`);
      }}
      placeholder="Project"
    />
  );
}
