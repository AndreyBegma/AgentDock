'use client';

import { APPROVALS_LIVE_EVENT, type ApprovalsView } from '@agentdock/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useLive } from '../../lib/live/use-live';

/** Pushes arrive in bursts; one refetch covers them. */
const REFETCH_DEBOUNCE_MS = 300;

/**
 * How many pull requests wait for approval on `projectId` (spec 20 nav badge).
 * Zero outside a project, and on any error: the badge is a hint, not a gate.
 */
export function useWaitingApprovals(projectId: string | null): number {
  const [count, setCount] = useState(0);
  const [version, setVersion] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useLive(projectId ? `project:${projectId}` : null, (message) => {
    if (message.event !== APPROVALS_LIVE_EVENT) return;
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
    api<ApprovalsView>(`/projects/${projectId}/approvals`)
      .then((view) => {
        // `waiting` holds the current rows, approved ones included.
        if (!cancelled) {
          setCount(view.waiting.filter((i) => i.status === 'waiting').length);
        }
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
