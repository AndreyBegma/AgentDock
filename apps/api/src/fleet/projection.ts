import type { FleetLiveChange } from '@agentdock/shared';
import type { FleetEvent } from '@agentdock/shared/protocol';
import type { Prisma } from '@prisma/client';

export type Tx = Prisma.TransactionClient;

/** The project an event resolved to (runner + `project.root`). */
export interface ProjectRef {
  id: string;
  rootPath: string;
  /** The project's base branch, for a round whose event names none (spec 16). */
  base: string;
}

/** A parsed fleet event with its `ts` and `seq` in the types the rows use. */
export interface Applied<E extends FleetEvent = FleetEvent> {
  event: E;
  ts: Date;
  seq: bigint;
}

export type EventOf<T extends FleetEvent['type']> = Extract<
  FleetEvent,
  { type: T }
>;

/** Records what a projection changed, for the live push after commit (D9). */
export type Changes = (change: FleetLiveChange) => void;

/**
 * The worktree path `dispatch.sh` gives a slot (D1):
 * `<parent of root>/.wt-<basename of root>-<slot>`.
 */
export const worktreePath = (rootPath: string, slot: string): string => {
  const trimmed = rootPath.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  const parent = cut <= 0 ? '' : trimmed.slice(0, cut);
  return `${parent}/.wt-${trimmed.slice(cut + 1)}-${slot}`;
};
