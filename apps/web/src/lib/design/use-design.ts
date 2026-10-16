'use client';

import {
  BOARD_CHANGED_EVENT,
  type CardDesignLaunchRequest,
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
import { cardDesignApi, designApi, stackDesignApi } from './href';

/** Pushes come in bursts (a phase change, then the result); one refetch covers them. */
const REFETCH_DEBOUNCE_MS = 250;

/** Which request is in flight, so its button says so. */
export type DesignBusy =
  | 'patch'
  | 'generate'
  | 'comment'
  | 'revise'
  | 'approve'
  | 'stop';

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
 * Whether a push concerns a card's design (#243): a `design` push or a
 * `board.changed` one, both carrying the card's id. Until the design has
 * loaded the id is not known, so any card's push counts.
 */
export function isCardDesignChange(
  event: string,
  data: unknown,
  cardId: string | undefined,
): boolean {
  if (event !== DESIGN_LIVE_EVENT && event !== BOARD_CHANGED_EVENT) {
    return false;
  }
  if (typeof data !== 'object' || data === null) return false;
  const change = data as { cardId?: unknown };
  if (typeof change.cardId !== 'string') return false;
  return cardId === undefined || change.cardId === cardId;
}

/** One task's design, kept current like `usePlan`. */
export function useDesign(projectId: string, planId: string, taskKey: string) {
  return useDesignAt(
    projectId,
    designApi(projectId, planId, taskKey),
    (event, data) => isDesignChange(event, data, planId, taskKey),
  );
}

/** One board card's design (#243): the same viewer, at the card's base. */
export function useCardDesign(projectId: string, number: number) {
  const cardId = useRef<string | undefined>(undefined);
  const design = useDesignAt(
    projectId,
    cardDesignApi(projectId, number),
    (event, data) => isCardDesignChange(event, data, cardId.current),
  );
  const owner = design.data?.owner;
  cardId.current = owner?.kind === 'card' ? owner.cardId : undefined;
  return design;
}

/**
 * Whether a push concerns a stack's design (#480): a `design` push or a
 * `board.changed` one carrying the stack's id; any stack's until it loads.
 */
export function isStackDesignChange(
  event: string,
  data: unknown,
  stackId: string | undefined,
): boolean {
  if (event !== DESIGN_LIVE_EVENT && event !== BOARD_CHANGED_EVENT) {
    return false;
  }
  if (typeof data !== 'object' || data === null) return false;
  const change = data as { stackId?: unknown };
  if (typeof change.stackId !== 'string') return false;
  return stackId === undefined || change.stackId === stackId;
}

/** A stack's shared design (#480): the same viewer, at the stack's base. */
export function useStackDesign(projectId: string, number: number) {
  const stackId = useRef<string | undefined>(undefined);
  const design = useDesignAt(
    projectId,
    stackDesignApi(projectId, number),
    (event, data) => isStackDesignChange(event, data, stackId.current),
  );
  const owner = design.data?.owner;
  stackId.current = owner?.kind === 'stack' ? owner.stackId : undefined;
  return design;
}

/**
 * A design at `base`: loaded once, refetched on every push `concerns` accepts
 * (the push carries ids only), and after each of the person's own actions.
 */
export function useDesignAt(
  projectId: string,
  base: string,
  concerns: (event: string, data: unknown) => boolean,
) {
  const [version, setVersion] = useState(0);
  const section = useSection(() => api<TaskDesignView>(base), [base, version]);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useLive(`project:${projectId}`, (message) => {
    if (!concerns(message.event, message.data)) return;
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
    /** #322 D1: a card's launch popover sends its profile and model; a plan task's sends nothing. */
    generate: (body?: CardDesignLaunchRequest) =>
      run('generate', () =>
        api(`${base}/generate`, { method: 'POST', ...(body ? { body } : {}) }),
      ),
    comment: (body: DesignCommentRequest) =>
      run('comment', () =>
        api<DesignCommentView>(`${base}/comments`, { method: 'POST', body }),
      ),
    revise: (body?: CardDesignLaunchRequest) =>
      run('revise', () =>
        api(`${base}/revise`, { method: 'POST', ...(body ? { body } : {}) }),
      ),
    approve: (body: DesignApproveRequest) =>
      run('approve', () => api(`${base}/approve`, { method: 'POST', body })),
    /** #275 D5: stops the running stage; the design settles at rest. */
    stop: () => run('stop', () => api(`${base}/stop`, { method: 'POST' })),
  };

  return { ...section, busy, actions };
}
