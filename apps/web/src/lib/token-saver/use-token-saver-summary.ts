'use client';

import type { TokenSaverSummary } from '@agentdock/shared';
import { useSection } from '../section/use-section';
import { fetchTokenSaverSummary } from './actions';
import { emptySummary, mergeSummaries } from './summary';

/**
 * The summary of one project, or the sum of several (Usage on "all projects").
 * A project that does not answer is left out of a sum as long as one does; if
 * every one fails the section reports the first error (rule R2).
 */
export function useTokenSaverSummary(
  projectIds: readonly string[],
  range: { from: string; to: string } | null,
) {
  return useSection<TokenSaverSummary | null>(async () => {
    if (!range) return null;
    if (projectIds.length === 0) return emptySummary(range.from, range.to);
    const settled = await Promise.allSettled(
      projectIds.map((id) => fetchTokenSaverSummary(id, range)),
    );
    const ok = settled.flatMap((r) =>
      r.status === 'fulfilled' ? [r.value] : [],
    );
    if (ok.length === 0) {
      const failed = settled.find((r) => r.status === 'rejected');
      throw failed?.status === 'rejected' ? failed.reason : new Error('empty');
    }
    const [only] = ok;
    return ok.length === 1 && only
      ? only
      : mergeSummaries(ok, range.from, range.to);
  }, [projectIds.join(','), range?.from, range?.to]);
}
