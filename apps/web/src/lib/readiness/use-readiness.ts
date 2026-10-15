'use client';

import type {
  ProjectReadinessView,
  ReadinessAction,
  ReadinessBlocker,
} from '@agentdock/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

const inFlight = new Map<string, Promise<ProjectReadinessView>>();

/** One request per project at a time: components on a page share it. */
const fetchReadiness = (projectId: string): Promise<ProjectReadinessView> => {
  const running = inFlight.get(projectId);
  if (running) return running;
  const next = api<ProjectReadinessView>(
    `/projects/${projectId}/readiness`,
  ).finally(() => inFlight.delete(projectId));
  inFlight.set(projectId, next);
  return next;
};

export interface Readiness {
  /** Null until loaded, and when it could not be: a failed check blocks nothing. */
  view: ProjectReadinessView | null;
  blockers: (action: ReadinessAction) => ReadinessBlocker[];
  refresh: () => void;
}

/**
 * `GET /projects/:projectId/readiness` (D4): fetched on mount and on window
 * focus, and again after `refresh()`. Without an answer nothing is blocked —
 * the API still refuses with `no_profile` and the error text says why.
 */
export function useReadiness(projectId: string): Readiness {
  const [view, setView] = useState<ProjectReadinessView | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is refresh
  useEffect(() => {
    let current = true;
    fetchReadiness(projectId).then(
      (next) => {
        if (current) setView(next);
      },
      () => {
        // Keep what we had.
      },
    );
    return () => {
      current = false;
    };
  }, [projectId, tick]);

  useEffect(() => {
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);

  const blockers = useCallback(
    (action: ReadinessAction): ReadinessBlocker[] =>
      view?.actions[action] ?? [],
    [view],
  );
  return { view, blockers, refresh };
}
