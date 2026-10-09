'use client';

import type { AdminRunnerDetail } from '@agentdock/shared';
import { terminalAvailable } from '@agentdock/shared/protocol';
import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Whether Attach is offered: the caller is an admin and the project's runner
 * reports `terminal: true` (spec 29 UI). Any failure hides the button; the API
 * decides regardless.
 */
export function useTerminalAvailable(
  runnerId: string | undefined,
  isAdmin: boolean,
): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!isAdmin || !runnerId) {
      setAvailable(false);
      return;
    }
    let cancelled = false;
    api<AdminRunnerDetail>(`/admin/runners/${runnerId}`)
      .then((runner) => {
        if (!cancelled) {
          setAvailable(
            runner.capabilities !== null &&
              terminalAvailable(runner.capabilities),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runnerId, isAdmin]);
  return available;
}
