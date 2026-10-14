'use client';

import {
  FLEET_LIVE_EVENT,
  type FleetGraph,
  type OrchestratorSettingsView,
  type SlotConversation,
  type SlotDetail,
  type SlotWorktreeView,
} from '@agentdock/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useLive } from '../live/use-live';
import { useSection } from '../section/use-section';
import { type PanelRefetch, parseFleetChange, refetchFor } from './live';

/** Pushes arrive in bursts (one per projected batch); one refetch covers them. */
const REFETCH_DEBOUNCE_MS = 300;

const NOTHING: PanelRefetch = {
  detail: false,
  conversation: false,
  graph: false,
};

const slotPath = (projectId: string, slot: string) =>
  `/projects/${projectId}/slots/${encodeURIComponent(slot)}`;

/**
 * What the agent panel shows for one slot, kept current by the `fleet` topic:
 * the run (`/slots/:slot`), its conversation, the fleet graph (sub-agents and
 * dependencies) and the orchestrator's settings (the runtime profile). Each is
 * its own section, so one failing leaves the others on screen (rule R2).
 *
 * Mount it per slot (`key={slot}`): a section keeps its data across a change
 * of dependencies, and another slot's data must never show under this name.
 */
export function useSlotPanel(projectId: string, slot: string) {
  const [versions, setVersions] = useState({
    detail: 0,
    conversation: 0,
    graph: 0,
  });

  const detail = useSection(
    () => api<SlotDetail>(slotPath(projectId, slot)),
    [projectId, slot, versions.detail],
  );
  const conversation = useSection(
    () => api<SlotConversation>(`${slotPath(projectId, slot)}/conversation`),
    [projectId, slot, versions.conversation],
  );
  const graph = useSection(
    () => api<FleetGraph>(`/projects/${projectId}/fleet/graph`),
    [projectId, versions.graph],
  );
  const settings = useSection(
    () =>
      api<OrchestratorSettingsView>(
        `/projects/${projectId}/orchestrator/settings`,
      ),
    [projectId],
  );

  const slotId = detail.data?.id;
  const pending = useRef<PanelRefetch>(NOTHING);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useLive(`project:${projectId}`, (message) => {
    if (message.event !== FLEET_LIVE_EVENT) return;
    const change = parseFleetChange(message.data);
    if (!change) return;
    const next = refetchFor(change, slotId);
    const was = pending.current;
    pending.current = {
      detail: was.detail || next.detail,
      conversation: was.conversation || next.conversation,
      graph: was.graph || next.graph,
    };
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const due = pending.current;
      pending.current = NOTHING;
      setVersions((v) => ({
        detail: v.detail + (due.detail ? 1 : 0),
        conversation: v.conversation + (due.conversation ? 1 : 0),
        graph: v.graph + (due.graph ? 1 : 0),
      }));
    }, REFETCH_DEBOUNCE_MS);
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  return {
    detail,
    conversation,
    graph,
    settings,
    /** Bumped with the detail, so an open Worktree tab follows the run. */
    detailVersion: versions.detail,
  };
}

/**
 * The slot's worktree, asked of the runner only while `enabled` (the Worktree
 * or Files tab is open). The API caches each answer for 10 s, so moving
 * between the two tabs, or Refresh, does not reach the runner every time.
 */
export function useSlotWorktree(
  projectId: string,
  slot: string,
  enabled: boolean,
  version: number,
) {
  return useSection<SlotWorktreeView | undefined>(
    () =>
      enabled
        ? api<SlotWorktreeView>(`${slotPath(projectId, slot)}/worktree`)
        : Promise.resolve(undefined),
    [projectId, slot, enabled, version],
  );
}
