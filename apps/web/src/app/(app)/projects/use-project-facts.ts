'use client';

import type { FleetView } from '@nautelle/shared';
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';

/** `undefined` while loading, `null` when the request failed. */
export type Fact<T> = T | null | undefined;

export interface ProjectFacts {
  fleets: Readonly<Record<string, Fact<FleetView>>>;
}

/**
 * What the Projects list shows beside each project: its fleet (orchestrator
 * and slots). A failed request leaves that card on a dash; it never blanks
 * the list.
 *
 * TODO(follow-up): a single aggregate endpoint would replace the per-project
 * fleet calls (issue #159).
 */
export function useProjectFacts(projectIds: readonly string[]): ProjectFacts {
  const [fleets, setFleets] = useState<Record<string, Fact<FleetView>>>({});
  const key = projectIds.join(',');

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `projectIds`.
  useEffect(() => {
    let cancelled = false;
    for (const id of projectIds) {
      api<FleetView>(`/projects/${id}/fleet`)
        .then((fleet) => {
          if (!cancelled) setFleets((prev) => ({ ...prev, [id]: fleet }));
        })
        .catch(() => {
          if (!cancelled) setFleets((prev) => ({ ...prev, [id]: null }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [key]);

  return { fleets };
}
