'use client';

import { BUDGET_UPDATED_LIVE_EVENT, type BudgetView } from '@agentdock/shared';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import { useLive } from '../live/use-live';

export interface BudgetsState {
  /** Undefined until the first answer. */
  budgets: BudgetView[] | undefined;
  /** The project does not exist or the caller is not a member (404). */
  missing: boolean;
  /** A failure other than 404; the last good list stays. */
  error: unknown;
  reload: () => Promise<void>;
}

function useBudgetList(
  path: string,
  topic: `project:${string}` | `user:${string}` | null,
): BudgetsState {
  const [budgets, setBudgets] = useState<BudgetView[]>();
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<unknown>();

  const reload = useCallback(async () => {
    try {
      setBudgets(await api<BudgetView[]>(path));
      setMissing(false);
      setError(undefined);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setMissing(true);
      else setError(err);
    }
  }, [path]);

  useEffect(() => {
    setBudgets(undefined);
    void reload();
  }, [reload]);

  // Spec 28 D12: a period update moves the indicators without a reload.
  useLive(topic, (message) => {
    if (message.event === BUDGET_UPDATED_LIVE_EVENT) void reload();
  });

  return { budgets, missing, error, reload };
}

/** A project's budgets, kept current by `budget.updated` on `project:<id>`. */
export const useProjectBudgets = (projectId: string): BudgetsState =>
  useBudgetList(`/projects/${projectId}/budgets`, `project:${projectId}`);

/** The signed-in user's own user budgets, kept current on `user:<id>`. */
export const useMyBudgets = (userId: string): BudgetsState =>
  useBudgetList('/me/budgets', `user:${userId}`);
