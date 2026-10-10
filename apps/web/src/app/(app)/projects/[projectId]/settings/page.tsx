'use client';

import type { ProjectDetail } from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { EmptyState } from 'glass-ui/empty-state';
import { Skeleton } from 'glass-ui/skeleton';
import { Tabs, TabsItem } from 'glass-ui/tabs';
import { toast } from 'glass-ui/toast';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../../../../../lib/api';
import { useLive } from '../../../../../lib/live/use-live';
import { describeProjectError } from '../../../../../lib/projects/format';
import { STATUS_TONE } from '../../../../../lib/runners/format';
import { BudgetTab } from './budget/budget-tab';
import { DocsTab } from './docs-tab';
import { GeneralTab } from './general-tab';
import { MembersTab } from './members-tab';
import { OrchestratorTab } from './orchestrator-tab';

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'docs', label: 'Docs source' },
  { id: 'orchestrator', label: 'Orchestrator' },
  { id: 'members', label: 'Members' },
  { id: 'budget', label: 'Budget' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export default function ProjectSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<ProjectDetail>();
  const [missing, setMissing] = useState(false);
  const [tab, setTab] = useState<TabId>('general');

  const load = useCallback(async () => {
    try {
      setProject(await api<ProjectDetail>(`/projects/${projectId}`));
      setMissing(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setMissing(true);
      else toast.error(describeProjectError(err));
    }
  }, [projectId]);

  useEffect(() => {
    setProject(undefined);
    load();
  }, [load]);

  // A link may carry the tab (`?tab=budget`, from the usage and fleet pages).
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('tab');
    const found = TABS.find(({ id }) => id === wanted);
    if (found) setTab(found.id);
  }, []);

  // The API publishes no project events yet; any that arrive reload the page.
  useLive(`project:${projectId}`, () => {
    void load();
  });

  if (missing) {
    return (
      <EmptyState
        title="Project not found"
        description="It was removed, or you are not a member of it."
      />
    );
  }
  if (!project) return <Skeleton className="h-64 w-full" />;

  const isAdmin = project.role === 'admin';
  const canOperate = project.role !== 'viewer';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{project.displayName}</h1>
          <p className="text-ink-2 flex flex-wrap items-center gap-2 text-sm">
            {project.repo}
            <span className="inline-flex items-center gap-1">
              <Badge
                dot
                tone={STATUS_TONE[project.runnerStatus]}
                aria-hidden="true"
              />
              {project.runnerName} ({project.runnerStatus})
            </span>
            <span>· your role: {project.role}</span>
          </p>
        </div>
      </div>

      <Tabs aria-label="Project settings" className="max-w-xl">
        {TABS.map(({ id, label }) => (
          <TabsItem key={id} current={tab === id} layoutId="project-tab">
            <button
              type="button"
              onClick={() => setTab(id)}
              aria-pressed={tab === id}
              className="relative flex w-full items-center justify-center px-3 py-2 text-sm font-medium"
            >
              {label}
            </button>
          </TabsItem>
        ))}
      </Tabs>

      {tab === 'general' ? (
        <GeneralTab project={project} isAdmin={isAdmin} onChanged={load} />
      ) : null}
      {tab === 'docs' ? (
        <DocsTab
          project={project}
          isAdmin={isAdmin}
          canRefresh={canOperate}
          onChanged={load}
        />
      ) : null}
      {tab === 'orchestrator' ? (
        <OrchestratorTab
          project={project}
          isAdmin={isAdmin}
          canOperate={canOperate}
        />
      ) : null}
      {tab === 'members' ? (
        <MembersTab projectId={project.id} isAdmin={isAdmin} />
      ) : null}
      {tab === 'budget' ? (
        <BudgetTab projectId={project.id} isAdmin={isAdmin} />
      ) : null}
    </div>
  );
}
