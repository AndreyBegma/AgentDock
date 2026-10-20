import { SLOT_WORKTREE_CACHE_MS } from '@nautelle/shared';

/** The worktree proxy's timings; e2e tests shorten them. */
export interface FleetWorkspaceOptions {
  /** How long a `worktree.status` answer is reused per slot. */
  worktreeCacheMs: number;
  /** Overrides the command's own timeout when set. */
  worktreeTimeoutMs?: number;
}

export const FLEET_WORKSPACE_OPTIONS = Symbol('FLEET_WORKSPACE_OPTIONS');

export const defaultFleetWorkspaceOptions: FleetWorkspaceOptions = {
  worktreeCacheMs: SLOT_WORKTREE_CACHE_MS,
};
