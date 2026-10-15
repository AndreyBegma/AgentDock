'use client';

import { FLEET_LIVE_EVENT, type FleetView } from '@agentdock/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { needsAttention } from '../../lib/fleet/format';
import { useLive } from '../../lib/live/use-live';

/** Pushes arrive in bursts; one refetch covers them. */
const REFETCH_DEBOUNCE_MS = 300;

/**
 * How many of `projectId`'s slots wait on a person (#163 rail badge on Fleet).
 * Zero outside a project, and on any error: the badge is a hint, not a gate.
 */
export function useSlotsNeedingAttention(projectId: string | null): number {
  const [count, setCount] = useState(0);
  const [version, setVersion] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useLive(projectId ? `project:${projectId}` : null, (message) => {
    if (message.event !== FLEET_LIVE_EVENT) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setVersion((v) => v + 1),
      REFETCH_DEBOUNCE_MS,
    );
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version is a refetch trigger
  useEffect(() => {
    if (!projectId) {
      setCount(0);
      return;
    }
    let cancelled = false;
    api<FleetView>(`/projects/${projectId}/fleet`)
      .then((fleet) => {
        if (!cancelled) setCount(fleet.slots.filter(needsAttention).length);
      })
      .catch(() => {
        if (!cancelled) setCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, version]);

  return count;
}
