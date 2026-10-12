import type {
  CollectorPollArgs,
  CollectorPollResult,
  WatchedProject,
} from '@agentdock/shared/protocol';
import { watchedById } from '../queue/project';

export interface CollectorPollDeps {
  watchedProjects: () => readonly WatchedProject[];
  /** The registry's `pollNow`; absent when this runner runs no collectors. */
  pollNow: (projectId: string, targets: readonly string[]) => Promise<string[]>;
}

/**
 * `collector.poll` (spec 27 D13): polls the named collectors of one watched
 * project now. Nothing is restarted and no other collector is touched; a
 * collector that is not running is simply absent from `restarted`.
 */
export const collectorPoll = async (
  args: CollectorPollArgs,
  deps: CollectorPollDeps,
): Promise<CollectorPollResult> => {
  watchedById(args.projectId, deps.watchedProjects());
  return { restarted: await deps.pollNow(args.projectId, args.collectors) };
};
