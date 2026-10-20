'use client';

import { type DockTab, DockTabs } from '@andrewbehma/glass-ui/dock-tabs';
import { type FleetGraph, slotNodeId } from '@nautelle/shared';
import { useMemo } from 'react';
import { PILL_STATUS, runningSentence } from '../../../../../lib/fleet/graph';

/** The agents opened in this workspace, along the bottom (#160). */
export function AgentDock({
  graph,
  open,
  focus,
  running,
  onSelect,
  onClose,
}: {
  graph: FleetGraph;
  open: readonly string[];
  focus: string | null;
  running: number;
  onSelect: (slot: string) => void;
  onClose: (slot: string) => void;
}) {
  const items = useMemo<DockTab[]>(() => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    return open.map((slot) => {
      const node = byId.get(slotNodeId(slot));
      // A tab whose slot left the graph (the run ended long ago) still closes.
      return node
        ? { id: slot, label: slot, status: PILL_STATUS[node.pill] }
        : { id: slot, label: slot, status: 'idle' };
    });
  }, [graph, open]);

  return (
    <DockTabs
      items={items}
      {...(focus !== null && open.includes(focus) ? { activeId: focus } : {})}
      onSelect={onSelect}
      onClose={onClose}
      status={runningSentence(running)}
      labels={{ tablist: 'Open agents' }}
    />
  );
}
