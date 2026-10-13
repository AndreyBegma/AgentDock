import type { OrchestratorStatus } from '@agentdock/shared';
import { RUNNERS_PAGE } from '../prerequisites/copy';

/** Why a control is off, as the next step (rule R1). */
export interface ControlReason {
  text: string;
  /** With `cta`: the page that removes the reason. */
  href?: string;
  cta?: string;
}

export interface ControlFacts {
  projectId: string;
  isAdmin: boolean;
  /** Null while the project's runner has not loaded yet: no reason is shown. */
  runnerOnline: boolean | null;
  runnerName: string | null;
  /** Null while the settings have not loaded. */
  profileSet: boolean | null;
  settingsFailed: boolean;
  orchestrator: OrchestratorStatus;
}

export const orchestratorSettingsHref = (projectId: string): string =>
  `/projects/${projectId}/settings?tab=orchestrator`;

function runnerReason(facts: ControlFacts): ControlReason {
  const name = facts.runnerName ?? 'The runner';
  return facts.isAdmin
    ? {
        text: `${name} is offline, so nothing can be sent to the project’s machine.`,
        href: RUNNERS_PAGE,
        cta: 'Open Runners',
      }
    : {
        text: `${name} is offline, so nothing can be sent to the project’s machine. Ask an administrator to start it.`,
      };
}

/** The orchestrator is running (or idle in its session) when it is neither absent nor unknown. */
export const orchestratorIsUp = (status: OrchestratorStatus): boolean =>
  status === 'running' || status === 'idle';

/** Why Start is disabled for a reason that will not clear on its own; null when it can be used. */
export function startDisabledReason(facts: ControlFacts): ControlReason | null {
  if (facts.runnerOnline === false) return runnerReason(facts);
  if (facts.settingsFailed) {
    return {
      text: 'The orchestrator settings could not be loaded, so Start has nothing to launch with. Reload the page to try again.',
    };
  }
  if (facts.profileSet === false) {
    return {
      text: 'No runtime profile is set for this project.',
      href: orchestratorSettingsHref(facts.projectId),
      cta: 'Choose a profile',
    };
  }
  if (orchestratorIsUp(facts.orchestrator)) {
    return { text: 'The orchestrator is already running.' };
  }
  return null;
}

/** Why Stop is disabled; null when it can be used. */
export function stopDisabledReason(facts: ControlFacts): ControlReason | null {
  if (facts.runnerOnline === false) return runnerReason(facts);
  if (facts.orchestrator === 'absent') {
    return {
      text: 'The orchestrator is not running, so there is nothing to stop.',
    };
  }
  return null;
}
