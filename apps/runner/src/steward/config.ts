import type { StewardRunnerConfig } from '@nautelle/shared';
import type { WatchedProject } from '@nautelle/shared/protocol';

export type StewardProjectConfig = StewardRunnerConfig & {
  project: WatchedProject;
};

/**
 * #447 D16: the project's Steward config when Steward is on there, else
 * null — absent (an API older than Steward) is off.
 */
export const stewardConfigOf = (
  projects: readonly WatchedProject[],
  projectId: string,
): StewardProjectConfig | null => {
  const project = projects.find((p) => p.id === projectId);
  const config = project?.steward;
  return project && config?.enabled ? { ...config, project } : null;
};
