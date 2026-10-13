'use client';

import type {
  OrchestratorSettingsView,
  OrchestratorStatus,
  ProjectDetail,
} from '@agentdock/shared';
import { useMemo } from 'react';
import {
  type ControlReason,
  startDisabledReason,
  stopDisabledReason,
} from '../../../../../lib/control/reasons';
import { isRunnerOnline } from '../../../../../lib/prerequisites/facts';
import type { Section } from '../../../../../lib/section/use-section';

export interface ControlReasons {
  start: ControlReason | null;
  stop: ControlReason | null;
}

/** Why Start and Stop are off right now (rule R1), from what the page already loaded. */
export function useControlReasons({
  projectId,
  isAdmin,
  project,
  settings,
  orchestrator = 'unknown',
}: {
  projectId: string;
  isAdmin: boolean;
  project: Pick<ProjectDetail, 'runnerName' | 'runnerStatus'> | undefined;
  settings: Section<OrchestratorSettingsView>;
  orchestrator?: OrchestratorStatus;
}): ControlReasons {
  const { data, error } = settings;
  return useMemo(() => {
    const facts = {
      projectId,
      isAdmin,
      runnerOnline: project ? isRunnerOnline(project.runnerStatus) : null,
      runnerName: project?.runnerName ?? null,
      profileSet: data ? data.effectiveProfile !== null : null,
      settingsFailed: data === undefined && error !== null,
      orchestrator,
    };
    return {
      start: startDisabledReason(facts),
      stop: stopDisabledReason(facts),
    };
  }, [projectId, isAdmin, project, data, error, orchestrator]);
}
