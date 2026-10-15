'use client';

import type { ReadinessAction, ReadinessBlockerCode } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { toast } from '@andrewbehma/glass-ui/toast';
import { useState } from 'react';
import { api, describeError } from '../../lib/api';
import { readinessCopy } from '../../lib/readiness/copy';
import {
  type Readiness,
  useReadiness,
} from '../../lib/readiness/use-readiness';
import { DisabledReason } from '../prerequisites/disabled-reason';
import { useCurrentUser } from '../shell/user-context';

/**
 * Rule R1 for #272 D5: what blocks `action` now, as the next step, under the
 * control it blocks. An admin can set the suggested profile as the project
 * default in one click; everyone else is told to ask one. Nothing while the
 * action is ready (or the check has not answered).
 */
export function ReadinessNotice({
  projectId,
  action,
  readiness,
  exclude,
  id,
}: {
  projectId: string;
  action: ReadinessAction;
  readiness: Readiness;
  /** Blockers another line of the page already says. */
  exclude?: readonly ReadinessBlockerCode[];
  /** Point the blocked control's `aria-describedby` here. */
  id?: string;
}) {
  const isAdmin = useCurrentUser().role === 'admin';
  const [busy, setBusy] = useState(false);
  const blockers = readiness
    .blockers(action)
    .filter((blocker) => !exclude?.includes(blocker.code));
  const suggestion = readiness.view?.suggestion ?? null;
  if (blockers.length === 0) return null;

  const setDefaultProfile = async (profileId: string) => {
    setBusy(true);
    try {
      await api(`/projects/${projectId}`, {
        method: 'PATCH',
        body: { defaultProfileId: profileId },
      });
      readiness.refresh();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id={id} className="flex flex-col gap-1.5">
      {blockers.map((blocker) => {
        const copy = readinessCopy(blocker, { isAdmin, projectId, suggestion });
        return (
          <div key={blocker.code} className="flex flex-col gap-1.5">
            <DisabledReason href={copy.href} cta={copy.cta}>
              {copy.text}
            </DisabledReason>
            {copy.useProfile ? (
              <div>
                <Button
                  variant="glass"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    if (copy.useProfile)
                      void setDefaultProfile(copy.useProfile.id);
                  }}
                >
                  {busy ? 'Saving…' : `Use ${copy.useProfile.label}`}
                </Button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** A notice that fetches for itself: beside a toggle that blocks nothing now. */
export function ReadinessSlot({
  projectId,
  action,
}: {
  projectId: string;
  action: ReadinessAction;
}) {
  const readiness = useReadiness(projectId);
  return (
    <ReadinessNotice
      projectId={projectId}
      action={action}
      readiness={readiness}
    />
  );
}
