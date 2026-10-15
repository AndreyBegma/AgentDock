'use client';

import {
  type CreatePlanCardsResponse,
  DESIGN_LIVE_EVENT,
  PLANNER_LIVE_EVENT,
  type PlanDetail,
  type PlanReviewDecision,
  type PlanTurnRequest,
  type PlanVisibility,
} from '@agentdock/shared';
import { toast } from '@andrewbehma/glass-ui/toast';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useLive } from '../live/use-live';
import { useSection } from '../section/use-section';
import { describePlannerError } from './format';
import { planApi, taskApi } from './href';

/** Pushes come in bursts (a phase change, then the result); one refetch covers them. */
const REFETCH_DEBOUNCE_MS = 250;

/** Which request is in flight, so its button says so. */
export type PlanBusy =
  | { kind: 'turn'; taskKey: string | null }
  | { kind: 'review'; taskKey: string }
  | { kind: 'approve_all' }
  | { kind: 'cancel' }
  | { kind: 'retry' }
  | { kind: 'revise' }
  | { kind: 'visibility' }
  | { kind: 'send' }
  | { kind: 'cards' }
  | { kind: 'archive' };

const isPlannerChange = (data: unknown, planId: string): boolean =>
  typeof data === 'object' &&
  data !== null &&
  'planId' in data &&
  (data as { planId: unknown }).planId === planId;

/**
 * One plan, kept current: loaded once, refetched on every `planner` or
 * `design` push for this plan on `project:<id>` (the push carries ids only,
 * so the refetch is what is authorized), and after each of the person's own
 * actions.
 */
export function usePlan(projectId: string, planId: string) {
  const [version, setVersion] = useState(0);
  const section = useSection(
    () => api<PlanDetail>(planApi(projectId, planId)),
    [projectId, planId, version],
  );

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useLive(`project:${projectId}`, (message) => {
    // A design push changes a task card's chip and status (spec 223).
    if (
      message.event !== PLANNER_LIVE_EVENT &&
      message.event !== DESIGN_LIVE_EVENT
    ) {
      return;
    }
    if (!isPlannerChange(message.data, planId)) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setVersion((v) => v + 1),
      REFETCH_DEBOUNCE_MS,
    );
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  const [busy, setBusy] = useState<PlanBusy | null>(null);

  /** Runs one request; a refusal is toasted and rethrown so a form keeps its input. */
  const run = useCallback(
    async <T>(what: PlanBusy, request: () => Promise<T>): Promise<T> => {
      setBusy(what);
      try {
        const result = await request();
        setVersion((v) => v + 1);
        return result;
      } catch (error) {
        toast.error(describePlannerError(error));
        throw error;
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const base = planApi(projectId, planId);
  const actions = {
    planTurn: (body: PlanTurnRequest) =>
      run({ kind: 'turn', taskKey: null }, () =>
        api(`${base}/turns`, { method: 'POST', body }),
      ),
    taskTurn: (key: string, body: PlanTurnRequest) =>
      run({ kind: 'turn', taskKey: key }, () =>
        api(`${taskApi(projectId, planId, key)}/turns`, {
          method: 'POST',
          body,
        }),
      ),
    review: (key: string, decision: PlanReviewDecision, comment?: string) =>
      run({ kind: 'review', taskKey: key }, () =>
        api(`${taskApi(projectId, planId, key)}/review`, {
          method: 'POST',
          body: comment === undefined ? { decision } : { decision, comment },
        }),
      ),
    /**
     * **Approve all drafts** (#213): one review per task, in order — there is
     * no bulk route. A refusal stops there; the refetch shows which went
     * through.
     */
    approveAll: (keys: readonly string[]) =>
      run({ kind: 'approve_all' }, async () => {
        try {
          for (const key of keys) {
            await api(`${taskApi(projectId, planId, key)}/review`, {
              method: 'POST',
              body: { decision: 'approve' },
            });
          }
        } catch (error) {
          setVersion((v) => v + 1);
          throw error;
        }
      }),
    revise: () =>
      run({ kind: 'revise' }, () => api(`${base}/revise`, { method: 'POST' })),
    setVisibility: (visibility: PlanVisibility) =>
      run({ kind: 'visibility' }, () =>
        api(`${base}/visibility`, { method: 'POST', body: { visibility } }),
      ),
    send: () =>
      run({ kind: 'send' }, () => api(`${base}/send`, { method: 'POST' })),
    /** #337 D7: one Todo card per task, once per plan. */
    createCards: () =>
      run({ kind: 'cards' }, () =>
        api<CreatePlanCardsResponse>(`${base}/cards`, { method: 'POST' }),
      ),
    archive: () =>
      run({ kind: 'archive' }, () =>
        api(`${base}/archive`, { method: 'POST' }),
      ),
    cancelTurn: (turnId: string) =>
      run({ kind: 'cancel' }, () =>
        api(`${base}/turns/${turnId}/cancel`, { method: 'POST' }),
      ),
    retryTurn: (turnId: string) =>
      run({ kind: 'retry' }, () =>
        api(`${base}/turns/${turnId}/retry`, { method: 'POST' }),
      ),
  };

  return { ...section, busy, actions };
}
