'use client';

import type { ReadinessBlocker } from '@agentdock/shared';
import { readinessCopy } from '../../lib/readiness/copy';
import type { Readiness } from '../../lib/readiness/use-readiness';
import { PrerequisiteBanner } from '../prerequisites/prerequisite-banner';
import { useCurrentUser } from '../shell/user-context';

/**
 * D6: one banner under the Board header for what stops Run (and Capture, when
 * it is on). An offline runner is `RunnerOfflineBanner`'s, not repeated here.
 */
export function ReadinessBanner({
  projectId,
  readiness,
  captureOn,
}: {
  projectId: string;
  readiness: Readiness;
  captureOn: boolean;
}) {
  const isAdmin = useCurrentUser().role === 'admin';
  const suggestion = readiness.view?.suggestion ?? null;
  const seen = new Set<string>();
  const blockers: ReadinessBlocker[] = [
    ...readiness.blockers('run'),
    ...(captureOn ? readiness.blockers('capture') : []),
  ].filter((blocker) => {
    if (blocker.code === 'runner_offline') return false;
    // The same profile problem blocks Run and Capture: say it once.
    const key = blocker.code;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const first = blockers[0];
  if (!first) return null;
  const copy = readinessCopy(first, { isAdmin, projectId, suggestion });
  return (
    <PrerequisiteBanner
      tone="warn"
      title={
        first.code === 'no_profile'
          ? 'Cards cannot run: no usable runtime profile.'
          : 'Something blocks card work.'
      }
      body={copy.text}
      href={copy.href}
      cta={copy.cta}
    />
  );
}
