'use client';

import { Combobox } from 'glass-ui/combobox';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

interface ProjectSummary {
  id: string;
  name: string;
}

/**
 * Project switcher (spec D3). `GET /api/projects` arrives with #10; until then
 * it answers 404 and this renders nothing, so it appears without a code change.
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
        // 404 before #10, or any failure: no switcher.
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
        label: project.name,
      }))}
      value={projectId}
      onValueChange={(id) => {
        if (id) router.push(`/projects/${id}/fleet`);
      }}
      placeholder="Project"
    />
  );
}
