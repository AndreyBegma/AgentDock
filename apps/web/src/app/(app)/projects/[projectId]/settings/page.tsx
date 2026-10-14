'use client';

import type { ProjectDetail } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { Tab, TabGroup, TabList, TabPanel } from '@andrewbehma/glass-ui/tabs';
import { toast } from '@andrewbehma/glass-ui/toast';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '../../../../../components/page-header/page-header';
import { ScrollX } from '../../../../../components/scroll-x/scroll-x';
import { ApiError, api } from '../../../../../lib/api';
import { useLive } from '../../../../../lib/live/use-live';
import { describeProjectError } from '../../../../../lib/projects/format';
import { useTabParam } from '../../../../../lib/projects/use-tab-param';
import { STATUS_TONE } from '../../../../../lib/runners/format';
import { BudgetTab } from './budget/budget-tab';
import { DocsTab } from './docs-tab';
import { GeneralTab } from './general-tab';
import { GitHubAppRow } from './github-app-row';
import { MembersTab } from './members-tab';
import { OrchestratorTab } from './orchestrator-tab';
import { PlannerTab } from './planner-tab';
import { SessionsTab } from './sessions-tab';

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'docs', label: 'Docs source' },
  { id: 'orchestrator', label: 'Orchestrator' },
  { id: 'members', label: 'Members' },
  { id: 'budget', label: 'Budget' },
  { id: 'planner', label: 'Planner' },
  { id: 'sessions', label: 'Sessions' },
] as const;
type TabId = (typeof TABS)[number]['id'];
const TAB_IDS = TABS.map(({ id }) => id);

export default function ProjectSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<ProjectDetail>();
  const [missing, setMissing] = useState(false);
  // `?tab=` carries the tab (links from the usage and fleet pages use it).
  const [tab, setTab] = useTabParam<TabId>(TAB_IDS);

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
      <PageHeader
        className="mb-0"
        eyebrow="Settings"
        title={project.displayName}
        description={
          <span className="flex flex-wrap items-center gap-2">
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
          </span>
        }
      />

      <TabGroup value={tab} onValueChange={(next) => setTab(next as TabId)}>
        {/* Seven tabs do not fit a phone: the strip scrolls inside its box. */}
        <ScrollX>
          <TabList aria-label="Project settings" className="min-w-max">
            {TABS.map(({ id, label }) => (
              <Tab key={id} value={id} className="whitespace-nowrap">
                {label}
              </Tab>
            ))}
          </TabList>
        </ScrollX>

        <TabPanel value="general" className="pt-4">
          <div className="flex flex-col gap-4">
            <GeneralTab project={project} isAdmin={isAdmin} onChanged={load} />
            <GitHubAppRow projectId={project.id} />
          </div>
        </TabPanel>
        <TabPanel value="docs" className="pt-4">
          <DocsTab
            project={project}
            isAdmin={isAdmin}
            canRefresh={canOperate}
            onChanged={load}
          />
        </TabPanel>
        <TabPanel value="orchestrator" className="pt-4">
          <OrchestratorTab
            project={project}
            isAdmin={isAdmin}
            canOperate={canOperate}
          />
        </TabPanel>
        <TabPanel value="members" className="pt-4">
          <MembersTab projectId={project.id} isAdmin={isAdmin} />
        </TabPanel>
        <TabPanel value="budget" className="pt-4">
          <BudgetTab projectId={project.id} isAdmin={isAdmin} />
        </TabPanel>
        <TabPanel value="planner" className="pt-4">
          <PlannerTab projectId={project.id} isAdmin={isAdmin} />
        </TabPanel>
        <TabPanel value="sessions" className="pt-4">
          <SessionsTab project={project} isAdmin={isAdmin} onChanged={load} />
        </TabPanel>
      </TabGroup>
    </div>
  );
}
