'use client';

import {
  type CreatePlanCardsResponse,
  type CreatePlanRequest,
  type PlannerSettingsView,
  type PlanSummary,
  type ProjectDetail,
  type ProjectRuntimeProfile,
  projectRoleAtLeast,
  type UiProfileView,
} from '@agentdock/shared';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { SheetContent, SheetRoot } from '@andrewbehma/glass-ui/sheet';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { useState } from 'react';
import { api } from '../../lib/api';
import { uiProfileApi } from '../../lib/design/href';
import {
  describePlannerError,
  isRunnerTooOldError,
} from '../../lib/planner/format';
import {
  plannerRunnerBlock,
  runnerGateCopy,
} from '../../lib/planner/runner-support';
import { usePlan } from '../../lib/planner/use-plan';
import { useErrorToast } from '../../lib/section/use-error-toast';
import { useSection } from '../../lib/section/use-section';
import {
  preselectedModel,
  useUserSettings,
} from '../../lib/settings/user-settings';
import { skillRunProfiles } from '../../lib/skills/format';
import { Composer } from '../planner/composer';
import { PlanWorkspace } from '../planner/plan-workspace';
import { PrerequisiteBanner } from '../prerequisites/prerequisite-banner';

/** The panel is a work surface, not a side note: as wide as the screen allows. */
const PANEL_CLASS = 'w-[min(72rem,100vw)]';

/**
 * New Plan on the Board (#337 D7): a full-height panel. Before the plan
 * exists it is the composer — brief, mode, the planning model (D9) and the
 * profile; then the Planner conversation, task cards and graph, ending in
 * **Create cards** (one Todo card per task, with Depends on links) or **Send
 * to fleet**. Closing it keeps an unfinished plan in Drafts.
 */
export function PlanPanel({
  projectId,
  project,
  open,
  planId,
  initialBrief,
  userId,
  onOpenChange,
  onStarted,
  onCardsCreated,
}: {
  projectId: string;
  project: ProjectDetail | undefined;
  open: boolean;
  /** The plan shown; undefined while the composer is. */
  planId: string | undefined;
  initialBrief: string;
  userId: string;
  onOpenChange: (open: boolean) => void;
  onStarted: (planId: string) => void;
  onCardsCreated: (created: CreatePlanCardsResponse) => void;
}) {
  return (
    <SheetRoot open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        title="New plan"
        description="The planner splits a brief into tasks. End with cards on the Board, or send the tasks to the fleet."
        className={PANEL_CLASS}
        footer={<PlanPanelFooter onClose={() => onOpenChange(false)} />}
      >
        {open ? (
          planId ? (
            <PlanBody
              projectId={projectId}
              project={project}
              planId={planId}
              userId={userId}
              onClose={() => onOpenChange(false)}
              onCardsCreated={onCardsCreated}
            />
          ) : (
            <StartPlan
              projectId={projectId}
              project={project}
              initialBrief={initialBrief}
              onStarted={onStarted}
            />
          )
        ) : null}
      </SheetContent>
    </SheetRoot>
  );
}

/** A visible, keyboard-reachable way out, like New card's Cancel (#398). */
export function PlanPanelFooter({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex items-center justify-end">
      <Button type="button" variant="glass" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}

function StartPlan({
  projectId,
  project,
  initialBrief,
  onStarted,
}: {
  projectId: string;
  project: ProjectDetail | undefined;
  initialBrief: string;
  onStarted: (planId: string) => void;
}) {
  const canOperate =
    project !== undefined && projectRoleAtLeast(project.role, 'operator');
  const settings = useUserSettings(canOperate);
  const profiles = useSection<ProjectRuntimeProfile[]>(
    () =>
      canOperate
        ? api<ProjectRuntimeProfile[]>(
            `/projects/${projectId}/runtime-profiles`,
          ).then(skillRunProfiles)
        : Promise.resolve([]),
    [canOperate, projectId],
  );
  const showError = useErrorToast();
  const [createdTooOld, setCreatedTooOld] = useState(false);
  // #233: the runner's advert decides before any turn.
  const runnerBlock = plannerRunnerBlock({
    project,
    createdTooOld,
    newestReason: null,
  });
  const runnerCopy = runnerBlock
    ? runnerGateCopy('planner', runnerBlock.gate)
    : null;

  const create = async (request: CreatePlanRequest) => {
    try {
      const plan = await api<PlanSummary>(`/projects/${projectId}/plans`, {
        method: 'POST',
        body: request,
      });
      onStarted(plan.id);
    } catch (error) {
      setCreatedTooOld(isRunnerTooOldError(error));
      showError(describePlannerError(error));
      throw error;
    }
  };

  // The composer keeps its own model pick: mount it once the setting is in.
  if (canOperate && settings.data === undefined && !settings.error) {
    return <Skeleton className="h-64 w-full" />;
  }

  return (
    <div className="flex min-w-0 flex-col gap-4 pb-4">
      {runnerCopy ? (
        <PrerequisiteBanner
          tone="warn"
          title={runnerCopy.title}
          body={runnerCopy.body}
          href={runnerCopy.href}
          cta={runnerCopy.cta}
        />
      ) : null}
      <Composer
        projectId={projectId}
        initialBrief={initialBrief}
        defaultModel={preselectedModel(settings.data)}
        profiles={profiles.error ? 'failed' : profiles.data}
        disabledReason={
          project === undefined
            ? 'Loading the project…'
            : canOperate
              ? null
              : 'Only operators start a plan.'
        }
        runnerReason={
          runnerCopy && runnerBlock?.known
            ? {
                text: runnerCopy.reason,
                href: runnerCopy.href,
                cta: runnerCopy.cta,
              }
            : null
        }
        onCreate={create}
      />
    </div>
  );
}

function PlanBody({
  projectId,
  project,
  planId,
  userId,
  onClose,
  onCardsCreated,
}: {
  projectId: string;
  project: ProjectDetail | undefined;
  planId: string;
  userId: string;
  onClose: () => void;
  onCardsCreated: (created: CreatePlanCardsResponse) => void;
}) {
  const role = project?.role ?? 'viewer';
  const section = usePlan(projectId, planId);
  const settings = useSection(
    () => api<PlannerSettingsView>(`/projects/${projectId}/planner/settings`),
    [projectId],
  );
  const profile = useSection(
    () => api<UiProfileView>(uiProfileApi(projectId)),
    [projectId],
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const plan = section.data;

  if (!plan) {
    return section.error ? (
      <Banner
        tone="danger"
        title="The plan could not be loaded"
        action={
          <Button size="sm" variant="glass" onClick={section.retry}>
            Try again
          </Button>
        }
      >
        {describePlannerError(section.error)}
      </Banner>
    ) : (
      <Skeleton className="h-64 w-full" />
    );
  }

  return (
    <div className="pb-4">
      <PlanWorkspace
        plan={plan}
        projectId={projectId}
        selectedKey={selectedKey}
        onSelect={setSelectedKey}
        isAuthor={plan.author.id === userId}
        isProjectAdmin={role === 'admin'}
        canOperate={projectRoleAtLeast(role, 'operator')}
        specOutput={settings.data?.specOutput}
        busy={section.busy}
        actions={section.actions}
        hasUi={profile.data?.current?.hasUi ?? null}
        onRefresh={section.retry}
        onArchived={onClose}
        onCardsCreated={onCardsCreated}
        compact
      />
    </div>
  );
}
