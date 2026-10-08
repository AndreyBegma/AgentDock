import type { WatchedProject } from '@agentdock/shared/protocol';
import { parseWorktreeList } from '../collectors/worktrees/worktrees';
import { CommandFailure } from '../commands/failure';
import type { Exec } from '../detect/exec';
import { resolveFleetProject } from '../fleet/project';
import { ownedSlot, slotOfWorktree } from '../fleet/session-name';
import type { TmuxControl } from './tmux';

/**
 * The watched project a control command names. `projectId` and `root` must be
 * one entry of the watch list, as `project.refresh` requires (spec 10 D10).
 */
export const watchedProject = (
  args: { projectId: string; root: string },
  watched: readonly WatchedProject[],
): WatchedProject => {
  const project = watched.find(
    (p) => p.id === args.projectId && p.root === args.root,
  );
  if (!project) {
    throw new CommandFailure(
      'path_not_allowed',
      `${args.root} is not a watched project of ${args.projectId}`,
    );
  }
  return project;
};

export interface SlotTarget {
  slot: string;
  /** The slot's worktree, as `git worktree list` records it for the root. */
  worktree: string;
  /** The slot's live tmux sessions in this project (spec 17 D12). */
  sessions: string[];
}

/**
 * A slot of this project (spec 17 D6, D12): its `.wt-<repo>-<slot>` worktree
 * must be one git lists for the root, else `path_not_allowed` — a slot of
 * another project never resolves. Its sessions are the live ones the shared
 * helper attributes to that slot, so `cs-<slot>` and `cs-<prefix>--<slot>`
 * both count and `cs-<other>--<slot>` never does.
 */
export const resolveSlot = async (
  exec: Exec,
  tmux: TmuxControl,
  project: WatchedProject,
  slot: string,
): Promise<SlotTarget> => {
  const { root } = project;
  const listed = await exec('git', [
    '-C',
    root,
    'worktree',
    'list',
    '--porcelain',
  ]);
  if (!listed || listed.code !== 0) {
    throw new CommandFailure(
      'not_a_repository',
      `cannot list the worktrees of ${root}`,
    );
  }
  const worktrees = new Map<string, string>();
  for (const entry of parseWorktreeList(listed.stdout)) {
    const owner = slotOfWorktree(root, entry.path);
    if (owner && !entry.prunable) worktrees.set(owner, entry.path);
  }
  const worktree = worktrees.get(slot);
  if (!worktree) {
    throw new CommandFailure(
      'path_not_allowed',
      `${slot} has no worktree in ${root}`,
    );
  }

  const fleet = await resolveFleetProject(exec, project);
  const ownership = {
    root,
    worktreeSlots: new Set(worktrees.keys()),
    configuredPrefix: fleet.sessionPrefix,
  };
  const sessions = (await tmux.sessions())
    .map((s) => s.name)
    .filter((name) => ownedSlot(name, ownership) === slot);
  return { slot, worktree, sessions };
};
