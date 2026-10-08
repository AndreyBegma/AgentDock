import type {
  SessionBackfillArgs,
  SessionBackfillResult,
  WatchedProject,
} from '@agentdock/shared/protocol';
import type { BackfillScope } from '../adapters';
import { CommandFailure } from './failure';

export interface SessionBackfillContext {
  /** The session watcher's backfill; absent when `sessions.enabled` is false. */
  backfill?: (scope: BackfillScope) => Promise<SessionBackfillResult>;
  watchedProjects: () => readonly WatchedProject[];
}

/**
 * `session.backfill { projectId?, since }` (D11, admin): re-reads transcripts
 * modified after `since` from their start. A `projectId` must be on the watch
 * list — the runner correlates sessions only to projects it watches.
 */
export const sessionBackfill = (
  args: SessionBackfillArgs,
  context: SessionBackfillContext,
): Promise<SessionBackfillResult> => {
  if (!context.backfill) {
    throw new CommandFailure(
      'disabled',
      'sessions are disabled on this runner (sessions.enabled)',
    );
  }
  if (
    args.projectId !== undefined &&
    !context.watchedProjects().some((p) => p.id === args.projectId)
  ) {
    throw new CommandFailure(
      'path_not_allowed',
      `project ${args.projectId} is not on this runner's watch list`,
    );
  }
  return context.backfill({
    ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
    since: new Date(args.since),
  });
};
