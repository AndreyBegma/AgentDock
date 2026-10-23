'use client';

import type { LocalRunner } from '@nautelle/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import {
  type RunnerUpdateNotice,
  readDismissedRelease,
  runnerUpdateNotice,
  storeDismissedRelease,
} from '../../lib/runners/update';

/**
 * C-328: the caller's runners, read once when the shell mounts, and the
 * update notice for them with its dismissal. The API answers from its cached
 * release: a page view never reaches the npm registry.
 */
export function useRunnerUpdate(): {
  notice: RunnerUpdateNotice | null;
  dismiss: () => void;
} {
  const [runners, setRunners] = useState<LocalRunner[]>([]);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    setDismissed(readDismissedRelease());
    let cancelled = false;
    api<LocalRunner[]>('/runners/local')
      .then((list) => {
        if (!cancelled && Array.isArray(list)) setRunners(list);
      })
      .catch(() => {
        // No notice; Runners and the runner itself still say its version.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const notice = runnerUpdateNotice(runners, dismissed);
  const latest = notice?.latest ?? null;
  const dismiss = useCallback(() => {
    if (!latest) return;
    setDismissed(latest);
    storeDismissedRelease(latest);
  }, [latest]);
  return { notice, dismiss };
}
