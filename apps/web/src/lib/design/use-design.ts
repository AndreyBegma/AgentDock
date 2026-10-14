'use client';

import {
  DESIGN_LIVE_EVENT,
  type DesignApproveRequest,
  type DesignCommentRequest,
  type DesignCommentView,
  PLANNER_LIVE_EVENT,
  type TaskDesignPatchRequest,
  type TaskDesignView,
} from '@agentdock/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useLive } from '../live/use-live';
import { useErrorToast } from '../section/use-error-toast';
import { useSection } from '../section/use-section';
import { describeDesignError } from './format';
import { designApi } from './href';

/** Pushes come in bursts (a phase change, then the result); one refetch covers them. */
const REFETCH_DEBOUNCE_MS = 250;

/** Which request is in flight, so its button says so. */
export type DesignBusy =
  | 'patch'
  | 'generate'
  | 'comment'
  | 'revise'
  | 'approve';

/**
 * Whether a push concerns this task's design: a `design` push for the task
 * (or for the whole plan), or a `planner` push for the plan — a turn's phase
 * travels on the Planner's event.
 */
export function isDesignChange(
  event: string,
  data: unknown,
  planId: string,
  taskKey: string,
): boolean {
  if (event !== DESIGN_LIVE_EVENT && event !== PLANNER_LIVE_EVENT) return false;
  if (typeof data !== 'object' || data === null) return false;
  const change = data as { planId?: unknown; taskKey?: unknown };
  if (change.planId !== planId) return false;
  return (
    change.taskKey === undefined ||
    change.taskKey === null ||
    change.taskKey === taskKey
  );
}

/**
 * One task's design, kept current like `usePlan`: loaded once, refetched on
 * every push that concerns it (the push carries ids only), and after each of
 * the person's own actions.
 */
export function useDesign(projectId: string, planId: string, taskKey: string) {
  const [version, setVersion] = useState(0);
  const base = designApi(projectId, planId, taskKey);
  const section = useSection(() => api<TaskDesignView>(base), [base, version]);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useLive(`project:${projectId}`, (message) => {
    if (!isDesignChange(message.event, message.data, planId, taskKey)) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setVersion((v) => v + 1),
      REFETCH_DEBOUNCE_MS,
    );
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  const [busy, setBusy] = useState<DesignBusy | null>(null);
  const showError = useErrorToast();

  /** Runs one request; a refusal is toasted and rethrown so a form keeps its input. */
  const run = useCallback(
    async <T>(what: DesignBusy, request: () => Promise<T>): Promise<T> => {
      setBusy(what);
      try {
        const result = await request();
        setVersion((v) => v + 1);
        return result;
      } catch (error) {
        showError(describeDesignError(error, projectId));
        throw error;
      } finally {
        setBusy(null);
      }
    },
    [projectId, showError],
  );

  const actions = {
    patch: (body: TaskDesignPatchRequest) =>
      run('patch', () => api<TaskDesignView>(base, { method: 'PATCH', body })),
    generate: () =>
      run('generate', () => api(`${base}/generate`, { method: 'POST' })),
    comment: (body: DesignCommentRequest) =>
      run('comment', () =>
        api<DesignCommentView>(`${base}/comments`, { method: 'POST', body }),
      ),
    revise: () =>
      run('revise', () => api(`${base}/revise`, { method: 'POST' })),
    approve: (body: DesignApproveRequest) =>
      run('approve', () => api(`${base}/approve`, { method: 'POST', body })),
  };

  return { ...section, busy, actions };
}
