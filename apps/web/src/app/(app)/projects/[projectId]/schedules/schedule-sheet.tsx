'use client';

import type { ScheduleDetail } from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Banner } from 'glass-ui/banner';
import { SheetContent, SheetRoot } from 'glass-ui/sheet';
import { Skeleton } from 'glass-ui/skeleton';
import Link from 'next/link';
import { type ReactNode, useEffect, useState } from 'react';
import { api } from '../../../../../lib/api';
import { formatAgo } from '../../../../../lib/fleet/format';
import {
  DISABLED_REASON_LABEL,
  describeSchedulesError,
  describeTarget,
  FIRING_STATUS_LABEL,
  FIRING_STATUS_TONE,
  firingReasonLabel,
  formatFireTime,
  MISSED_POLICY_LABEL,
  nextRunLabel,
} from '../../../../../lib/schedules/format';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-medium text-ink-2">{label}</dt>
      <dd className="break-words text-sm">{children}</dd>
    </div>
  );
}

function Detail({ detail }: { detail: ScheduleDetail }) {
  return (
    <div className="flex flex-col gap-6">
      {detail.disabledReason ? (
        <Banner tone="warn" title="This schedule is off">
          {DISABLED_REASON_LABEL[detail.disabledReason]}
        </Banner>
      ) : null}
      <dl className="flex flex-col gap-4">
        <Row label="Runs">
          <span className="font-mono">{describeTarget(detail.target)}</span>
          {detail.target.kind === 'skill' ? (
            <div className="text-xs text-ink-2">
              {detail.target.model ?? 'default model'} ·{' '}
              {detail.target.output === 'pr' ? 'pull request' : 'report'}
            </div>
          ) : null}
        </Row>
        <Row label="When">
          <span className="font-mono">{detail.cron}</span>{' '}
          <span className="text-ink-2">({detail.timezone})</span>
        </Row>
        <Row label="Next run">{nextRunLabel(detail)}</Row>
        <Row label="If a run is missed">
          {MISSED_POLICY_LABEL[detail.missedPolicy]}
        </Row>
        {detail.consecutiveFailures > 0 ? (
          <Row label="Failures in a row">{detail.consecutiveFailures}</Row>
        ) : null}
      </dl>

      <section aria-labelledby="schedule-firings">
        <h3 id="schedule-firings" className="mb-2 text-sm font-semibold">
          Firings{' '}
          <span className="font-normal text-ink-3">
            (last {detail.firings.length})
          </span>
        </h3>
        {detail.firings.length === 0 ? (
          <p className="text-sm text-ink-2">Nothing has fired yet.</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {detail.firings.map((firing) => {
              const reason = firingReasonLabel(firing.reason);
              return (
                <li
                  key={firing.id}
                  className="flex flex-col gap-1 border-l border-line pl-3"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge
                      tone={FIRING_STATUS_TONE[firing.status]}
                      label={FIRING_STATUS_LABEL[firing.status]}
                    />
                    <span className="text-sm">
                      {formatFireTime(
                        firing.scheduledFor,
                        detail.timezone,
                        true,
                      )}
                    </span>
                    {firing.kind !== 'cron' ? (
                      <span className="text-xs text-ink-3">
                        {firing.kind === 'manual' ? 'run now' : 'catch-up'}
                      </span>
                    ) : null}
                  </span>
                  {reason ? (
                    <span className="text-xs text-ink-2">{reason}</span>
                  ) : null}
                  {firing.missedCount > 0 ? (
                    <span className="text-xs text-ink-2">
                      {firing.missedCount} earlier{' '}
                      {firing.missedCount === 1 ? 'time' : 'times'} also missed
                    </span>
                  ) : null}
                  {firing.runId ? (
                    <Link
                      href={`/projects/${detail.projectId}/history/${firing.runId}`}
                      className="text-xs underline underline-offset-2"
                    >
                      Open the run
                    </Link>
                  ) : null}
                  {firing.finishedAt ? (
                    <span className="text-xs text-ink-3">
                      finished {formatAgo(firing.finishedAt)}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}

/** Schedule detail with its firings (spec 25 UI). Refetches when `version` changes. */
export function ScheduleSheet({
  projectId,
  scheduleId,
  version,
  onClose,
}: {
  projectId: string;
  scheduleId: string | undefined;
  version: number;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<ScheduleDetail>();
  const [error, setError] = useState<string>();

  // `version` is a refetch trigger only: a live push bumps it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!scheduleId) {
      setDetail(undefined);
      setError(undefined);
      return;
    }
    let cancelled = false;
    api<ScheduleDetail>(`/projects/${projectId}/schedules/${scheduleId}`)
      .then((value) => {
        if (cancelled) return;
        setDetail(value);
        setError(undefined);
      })
      .catch((err) => {
        if (!cancelled) setError(describeSchedulesError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, scheduleId, version]);

  return (
    <SheetRoot
      open={scheduleId !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {scheduleId !== undefined ? (
        <SheetContent
          side="right"
          title={detail?.name ?? 'Schedule'}
          description="Schedule and its latest firings"
        >
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : detail ? (
            <Detail detail={detail} />
          ) : (
            <Skeleton className="h-48 w-full" />
          )}
        </SheetContent>
      ) : null}
    </SheetRoot>
  );
}
