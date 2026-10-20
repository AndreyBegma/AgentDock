'use client';

import type { ActionRequestSummary } from '@nautelle/shared';
import { useEffect, useRef } from 'react';
import { api } from '../api';
import { useLive } from '../live/use-live';
import { useSection } from '../section/use-section';
import { ACTION_REQUESTS_LIVE_EVENT } from './action-requests';

/** Pushes arrive in bursts; one refetch covers them. */
const REFETCH_DEBOUNCE_MS = 300;

/**
 * A project's action requests, every status, kept fresh by the live push
 * (`GET /projects/:id/action-requests`). The data stays on a failed refresh.
 */
export function useActionRequests(projectId: string) {
  const section = useSection(
    () => api<ActionRequestSummary[]>(`/projects/${projectId}/action-requests`),
    [projectId],
  );
  const { retry } = section;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useLive(`project:${projectId}`, (message) => {
    if (message.event !== ACTION_REQUESTS_LIVE_EVENT) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(retry, REFETCH_DEBOUNCE_MS);
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  return section;
}
