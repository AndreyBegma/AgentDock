import type { FleetLiveChange } from '@nautelle/shared';

const KINDS: readonly FleetLiveChange['kind'][] = [
  'slot',
  'round',
  'orchestrator',
  'conversation',
];

/** A `fleet` frame's payload, or null when it is not one. */
export function parseFleetChange(data: unknown): FleetLiveChange | null {
  if (typeof data !== 'object' || data === null) return null;
  const { kind, id } = data as Record<string, unknown>;
  if (typeof id !== 'string') return null;
  const known = KINDS.find((k) => k === kind);
  return known ? { kind: known, id } : null;
}

/** Which of the panel's sections a change makes stale. */
export interface PanelRefetch {
  detail: boolean;
  conversation: boolean;
  graph: boolean;
}

/**
 * - `slot` of this run: its row, its checkpoints (the worker's side of the
 *   chat) and its node moved. Another slot's row only moves the graph.
 * - `conversation` of this run: a new orchestrator message.
 * - `round`, `orchestrator`: the waves and the root of the tree.
 *
 * `slotId` is undefined while the run is not known yet (a planned slot, or
 * the first load); then any `slot` change may be its first run, so the
 * detail is fetched again.
 */
export function refetchFor(
  change: FleetLiveChange,
  slotId: string | undefined,
): PanelRefetch {
  const mine = slotId === undefined || change.id === slotId;
  switch (change.kind) {
    case 'slot':
      return { detail: mine, conversation: mine, graph: true };
    case 'conversation':
      return { detail: false, conversation: mine, graph: false };
    case 'round':
    case 'orchestrator':
      return { detail: false, conversation: false, graph: true };
  }
}
