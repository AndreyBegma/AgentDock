import type { IssuesRefreshResult } from '@agentdock/shared/protocol';

/** Polls one project's issues now, ignoring the ETag. */
export type IssuesRefresher = () => Promise<IssuesRefreshResult>;

/**
 * The running `issues` collectors by project, so `issues.refresh` can reach
 * the one it names. The daemon builds collectors and command handlers
 * separately; this is the only thing they share.
 */
export class IssuesRefreshers {
  private readonly byProject = new Map<string, IssuesRefresher>();

  register(projectId: string, refresher: IssuesRefresher): void {
    this.byProject.set(projectId, refresher);
  }

  /** Removes `refresher` only if it is still the one registered (a restart may have replaced it). */
  unregister(projectId: string, refresher: IssuesRefresher): void {
    if (this.byProject.get(projectId) === refresher) {
      this.byProject.delete(projectId);
    }
  }

  get(projectId: string): IssuesRefresher | undefined {
    return this.byProject.get(projectId);
  }
}

/** The process-wide instance the daemon's collector and handler both use. */
export const issuesRefreshers = new IssuesRefreshers();
