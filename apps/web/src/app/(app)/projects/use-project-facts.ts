'use client';

import type {
  FleetView,
  UsageSeries,
  UsageTimeseriesResponse,
} from '@agentdock/shared';
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { costQuery } from '../../../lib/projects/overview';

/** `undefined` while loading, `null` when the request failed. */
export type Fact<T> = T | null | undefined;

export interface ProjectFacts {
  fleets: Readonly<Record<string, Fact<FleetView>>>;
  cost: Fact<UsageSeries[]>;
}

/**
 * What the Projects list shows beside each project: its fleet (orchestrator,
 * slots, last round) and one cost series per project. One failed request
 * leaves that cell on a dash; it never blanks the list.
 *
 * TODO(follow-up): a single aggregate endpoint would replace the per-project
 * fleet calls (issue #159).
 */
export function useProjectFacts(projectIds: readonly string[]): ProjectFacts {
  const [fleets, setFleets] = useState<Record<string, Fact<FleetView>>>({});
  const [cost, setCost] = useState<Fact<UsageSeries[]>>();
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
    api<UsageTimeseriesResponse>(`/usage/timeseries?${costQuery(Date.now())}`)
      .then((response) => {
        if (!cancelled) setCost(response.series);
      })
      .catch(() => {
        if (!cancelled) setCost(null);
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return { fleets, cost };
}
