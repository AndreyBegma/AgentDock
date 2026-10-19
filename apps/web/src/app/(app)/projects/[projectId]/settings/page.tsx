'use client';

import type { ProjectDetail } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { Tab, TabGroup, TabList, TabPanel } from '@andrewbehma/glass-ui/tabs';
import { useParams } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { PageHeader } from '../../../../../components/page-header/page-header';
import { ScrollX } from '../../../../../components/scroll-x/scroll-x';
import { ApiError, api } from '../../../../../lib/api';
import { useLive } from '../../../../../lib/live/use-live';
import { describeProjectError } from '../../../../../lib/projects/format';
import { useTabParam } from '../../../../../lib/projects/use-tab-param';
import { STATUS_TONE } from '../../../../../lib/runners/format';
import { useErrorToast } from '../../../../../lib/section/use-error-toast';
import { AiDigestTab } from './ai-digest-tab';
import { BoardTab } from './board-tab';
import { BudgetTab } from './budget/budget-tab';
import { DesignTab } from './design/design-tab';
import { DocsTab } from './docs-tab';
import { GeneralTab } from './general-tab';
import { GitHubAppRow } from './github-app-row';
import { MembersTab } from './members-tab';
import { OrchestratorTab } from './orchestrator-tab';
import { PlannerTab } from './planner-tab';
import { RulesTab } from './rules/rules-tab';
import { SessionsTab } from './sessions-tab';
import { StewardTab } from './steward-tab';
import { TokenSaverTab } from './token-saver-tab';

/** What a tab's panel needs from the page. */
interface TabContext {
  project: ProjectDetail;
  isAdmin: boolean;
  canOperate: boolean;
  reload: () => void;
}

/** One entry per tab: a new tab is one line here. */
const TABS: readonly {
  id: string;
  label: string;
  render: (ctx: TabContext) => ReactNode;
}[] = [
  {
    id: 'general',
    label: 'General',
    render: ({ project, isAdmin, reload }) => (
      <div className="flex flex-col gap-4">
        <GeneralTab project={project} isAdmin={isAdmin} onChanged={reload} />
        <GitHubAppRow projectId={project.id} />
      </div>
    ),
  },
  {
    id: 'docs',
    label: 'Docs source',
    render: ({ project, isAdmin, canOperate, reload }) => (
      <DocsTab
        project={project}
        isAdmin={isAdmin}
        canRefresh={canOperate}
        onChanged={reload}
      />
    ),
  },
  {
    id: 'rules',
    label: 'Coding rules',
    render: ({ project, isAdmin }) => (
      <RulesTab projectId={project.id} isAdmin={isAdmin} />
    ),
  },
  {
    id: 'orchestrator',
    label: 'Orchestrator',
    render: ({ project, isAdmin, canOperate }) => (
      <OrchestratorTab
        project={project}
        isAdmin={isAdmin}
        canOperate={canOperate}
      />
    ),
  },
  {
    id: 'members',
    label: 'Members',
    render: ({ project, isAdmin }) => (
      <MembersTab projectId={project.id} isAdmin={isAdmin} />
    ),
  },
  {
    id: 'budget',
    label: 'Budget',
    render: ({ project, isAdmin }) => (
      <BudgetTab projectId={project.id} isAdmin={isAdmin} />
    ),
  },
  {
    id: 'planner',
    label: 'Planner',
    render: ({ project, isAdmin }) => (
      <PlannerTab projectId={project.id} isAdmin={isAdmin} />
    ),
  },
  {
    id: 'design',
    label: 'Design',
    render: ({ project, isAdmin, canOperate }) => (
      <DesignTab
        projectId={project.id}
        isAdmin={isAdmin}
        canOperate={canOperate}
      />
    ),
  },
  {
    id: 'board',
    label: 'Board',
    render: ({ project, isAdmin, canOperate }) => (
      <BoardTab
        projectId={project.id}
        isAdmin={isAdmin}
        canOperate={canOperate}
        contentOn={project.shipSessionContent ?? false}
      />
    ),
  },
  {
    id: 'token-saver',
    label: 'Token saver',
    render: ({ project, isAdmin, canOperate }) => (
      <TokenSaverTab
        projectId={project.id}
        isAdmin={isAdmin}
        canOperate={canOperate}
      />
    ),
  },
  {
    id: 'steward',
    label: 'Steward',
    render: ({ project, isAdmin }) => (
      <StewardTab projectId={project.id} isAdmin={isAdmin} />
    ),
  },
  {
    id: 'ai-digest',
    label: 'AI digest',
    render: ({ project, isAdmin }) => (
      <AiDigestTab projectId={project.id} isAdmin={isAdmin} />
    ),
  },
  {
    id: 'sessions',
    label: 'Sessions',
    render: ({ project, isAdmin, reload }) => (
      <SessionsTab project={project} isAdmin={isAdmin} onChanged={reload} />
    ),
  },
];
const TAB_IDS = TABS.map(({ id }) => id);

export default function ProjectSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<ProjectDetail>();
  const [missing, setMissing] = useState(false);
  // `?tab=` carries the tab (links from the usage and fleet pages use it).
  const [tab, setTab] = useTabParam(TAB_IDS);
  const showError = useErrorToast();

  const load = useCallback(async () => {
    try {
      setProject(await api<ProjectDetail>(`/projects/${projectId}`));
      setMissing(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setMissing(true);
      else showError(describeProjectError(err));
    }
  }, [projectId, showError]);

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
        title="Settings"
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">{project.displayName}</span>
            <span>· {project.repo}</span>
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

      <TabGroup value={tab} onValueChange={setTab}>
        {/* Twelve tabs do not fit a phone: the strip scrolls inside its box. */}
        <ScrollX>
          <TabList aria-label="Project settings" className="min-w-max">
            {TABS.map(({ id, label }) => (
              <Tab key={id} value={id} className="whitespace-nowrap">
                {label}
              </Tab>
            ))}
          </TabList>
        </ScrollX>

        {TABS.map(({ id, render }) => (
          <TabPanel key={id} value={id} className="pt-4">
            {render({ project, isAdmin, canOperate, reload: load })}
          </TabPanel>
        ))}
      </TabGroup>
    </div>
  );
}
