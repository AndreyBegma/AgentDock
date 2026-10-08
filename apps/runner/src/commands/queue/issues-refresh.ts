import type {
  IssuesRefreshResult,
  WatchedProject,
} from '@agentdock/shared/protocol';
import {
  type IssuesRefreshers,
  issuesRefreshers,
} from '../../collectors/issues/refresh';
import { CommandFailure } from '../failure';
import { watchedById } from './project';

export interface IssuesRefreshDeps {
  watchedProjects: () => readonly WatchedProject[];
  /** Default: the process-wide set the `issues` collectors register in. */
  refreshers?: IssuesRefreshers;
}

/** `issues.refresh` (spec 19): polls the project's issues now, ignoring the ETag. */
export const issuesRefresh = async (
  args: { projectId: string },
  deps: IssuesRefreshDeps,
): Promise<IssuesRefreshResult> => {
  watchedById(args.projectId, deps.watchedProjects());
  const refresh = (deps.refreshers ?? issuesRefreshers).get(args.projectId);
  if (!refresh) {
    throw new CommandFailure(
      'path_not_allowed',
      `no issues collector is running for ${args.projectId}`,
    );
  }
  return refresh();
};
