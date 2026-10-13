import type {
  AdminRunner,
  GitHubProjectAppStatus,
  OrchestratorSettingsView,
  ProjectSummary,
  RunnerStatus,
} from '@agentdock/shared';

/** One fact as it loads: each is fetched, and can fail, on its own. */
export type Loadable<T> =
  | { state: 'loading' }
  | { state: 'ready'; value: T }
  | { state: 'error'; error: unknown };

/** A paired runner that is not online, for the "start it" message. */
export interface IdleRunner {
  id: string;
  name: string;
  hostname: string | null;
}

/**
 * Whether anything can reach a machine. `unknown` when the caller may not list
 * runners (`GET /admin/runners` is admin-only) — never a guess.
 */
export type RunnersFact =
  | { kind: 'none' }
  | { kind: 'offline'; runners: IdleRunner[] }
  | { kind: 'online'; online: number }
  | { kind: 'unknown' };

export interface ProjectRunnerFact {
  name: string;
  status: RunnerStatus;
  online: boolean;
}

export interface ProfileFact {
  /** A start without overrides has a profile to use. */
  set: boolean;
  label: string | null;
}

export interface GitHubAppFact {
  /** The App is installed on this project's repository. */
  installed: boolean;
}

/** `stale` is a runner whose heartbeat stopped: not reachable, so not online. */
export const isRunnerOnline = (status: RunnerStatus): boolean =>
  status === 'online';

/** Revoked runners do not count; a runner that never paired does not either. */
export function runnersFact(runners: readonly AdminRunner[]): RunnersFact {
  const paired = runners.filter(
    (runner) => runner.status !== 'revoked' && runner.pairedAt !== null,
  );
  if (paired.length === 0) return { kind: 'none' };
  const online = paired.filter((runner) => isRunnerOnline(runner.status));
  if (online.length > 0) return { kind: 'online', online: online.length };
  return {
    kind: 'offline',
    runners: paired.map(({ id, name, hostname }) => ({ id, name, hostname })),
  };
}

export const projectRunnerFact = (
  project: Pick<ProjectSummary, 'runnerName' | 'runnerStatus'>,
): ProjectRunnerFact => ({
  name: project.runnerName,
  status: project.runnerStatus,
  online: isRunnerOnline(project.runnerStatus),
});

export const profileFact = (
  settings: Pick<OrchestratorSettingsView, 'effectiveProfile'>,
): ProfileFact => ({
  set: settings.effectiveProfile !== null,
  label: settings.effectiveProfile?.label ?? null,
});

export const gitHubAppFact = (
  status: Pick<GitHubProjectAppStatus, 'covered'>,
): GitHubAppFact => ({ installed: status.covered });

/** The value when it is ready, else undefined — for "show the banner once we know". */
export const readyValue = <T>(fact: Loadable<T>): T | undefined =>
  fact.state === 'ready' ? fact.value : undefined;
