'use client';

import type {
  ActivityPage,
  ApprovalsView,
  FleetView,
  RunPage,
  RunSummary,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { buttonClassName } from '@andrewbehma/glass-ui/button';
import { Section } from '@andrewbehma/glass-ui/section';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import NextLink from 'next/link';
import type { ReactNode } from 'react';
import { AsyncSection } from '../../../../../components/prerequisites/async-section';
import { activityHref, itemTitle } from '../../../../../lib/activity/format';
import {
  checkpointLabel,
  SLOT_STATUS_LABEL,
} from '../../../../../lib/fleet/format';
import { slotHref } from '../../../../../lib/fleet/workspace-url';
import { Time } from '../../../../../lib/format/time';
import {
  costLabel,
  prLabel,
  RUN_STATUS_LABEL,
  runTitle,
} from '../../../../../lib/history/format';
import { slotHue } from '../../../../../lib/hue';
import {
  type NeedsYouItem,
  needsYou,
  recentResult,
} from '../../../../../lib/project-home/summary';
import type { Section as SectionState } from '../../../../../lib/section/use-section';
import { formatDuration } from '../../../../../lib/sessions/format';
import {
  RUN_PILL_STATUS,
  SLOT_PILL_STATUS,
} from '../../../../../lib/status/pill';

/** How many slots and events the home lists; Fleet and Activity have the rest. */
const FLEET_ROWS = 6;

const quietLink = buttonClassName({ variant: 'ghost', size: 'sm' });

const ROW =
  'flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-hover';

const NEEDS_PILL: Record<
  NeedsYouItem['kind'],
  { status: 'waiting' | 'blocked' | 'error'; label: string }
> = {
  approval: { status: 'waiting', label: 'Approval' },
  prompt: { status: 'blocked', label: 'Needs input' },
  checks: { status: 'error', label: 'Checks failed' },
  run: { status: 'waiting', label: 'Waiting for a person' },
};

const Quiet = ({ children }: { children: ReactNode }) => (
  <p className="px-4 py-3 text-sm text-ink-3">{children}</p>
);

/** Approvals, dialogs, failures: what waits for a person, newest concern first. */
export function NeedsYouSection({
  projectId,
  approvals,
  fleet,
  runs,
}: {
  projectId: string;
  approvals: SectionState<ApprovalsView>;
  fleet: SectionState<FleetView>;
  runs: SectionState<RunPage>;
}) {
  const loading =
    approvals.data === undefined &&
    fleet.data === undefined &&
    approvals.error === null &&
    fleet.error === null;
  const items = needsYou(
    projectId,
    approvals.data,
    fleet.data,
    runs.data?.items ?? [],
  );
  return (
    <Section
      title="Needs you"
      description="Approvals and failures waiting on a decision."
      pad="none"
      actions={
        <NextLink
          href={`/projects/${projectId}/approvals`}
          className={quietLink}
        >
          Open Approvals
        </NextLink>
      }
    >
      {loading ? (
        <Skeleton className="m-4 h-12" />
      ) : items.length === 0 ? (
        <Quiet>
          {approvals.error !== null || fleet.error !== null
            ? 'Some of this could not be loaded. Open Approvals or Fleet to check.'
            : 'Nothing is waiting for you.'}
        </Quiet>
      ) : (
        <ul className="divide-y divide-line">
          {items.map((item) => {
            const pill = NEEDS_PILL[item.kind];
            return (
              <li key={item.id}>
                <NextLink href={item.href} className={ROW}>
                  <StatusPill
                    size="md"
                    status={pill.status}
                    label={pill.label}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {item.title}
                    </span>
                    <span className="block truncate text-xs text-ink-3">
                      {item.detail}
                      {item.since ? (
                        <>
                          {item.detail ? ' · ' : ''}
                          <Time value={item.since} />
                        </>
                      ) : null}
                    </span>
                  </span>
                </NextLink>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/** The latest task that ended, with the facts the old Recent tasks table had. */
export function RecentResultSection({
  projectId,
  runs,
}: {
  projectId: string;
  runs: SectionState<RunPage>;
}) {
  const history = `/projects/${projectId}/history`;
  return (
    <Section
      title="Recent result"
      description="The last task that finished."
      pad="none"
      actions={
        <NextLink href={history} className={quietLink}>
          Open History
        </NextLink>
      }
    >
      <AsyncSection
        section={runs}
        unavailable={{
          title: 'The latest result could not be loaded',
          stillWorks: 'History still lists every run.',
        }}
        isEmpty={(page) => recentResult(page.items) === undefined}
        empty={<Quiet>No task has finished yet.</Quiet>}
        skeleton={<Skeleton className="m-4 h-12" />}
      >
        {(page) => {
          const run = recentResult(page.items);
          return run ? (
            <ResultRow run={run} href={`${history}/${run.id}`} />
          ) : null;
        }}
      </AsyncSection>
    </Section>
  );
}

function ResultRow({ run, href }: { run: RunSummary; href: string }) {
  const facts = [
    run.slot,
    run.prNumber === null ? null : prLabel(run),
    formatDuration(run.durationMs) || null,
    costLabel(run.usage),
  ].filter((fact) => fact && fact !== '—');
  return (
    <NextLink href={href} className={ROW}>
      <StatusPill
        size="md"
        status={RUN_PILL_STATUS[run.status]}
        label={RUN_STATUS_LABEL[run.status]}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {runTitle(run)}
        </span>
        <span className="block truncate text-xs text-ink-3">
          {facts.join(' · ')}
          {facts.length > 0 ? ' · ' : ''}
          <Time value={run.updatedAt} />
        </span>
      </span>
    </NextLink>
  );
}

/** The live slots at a glance, each opening its panel on the Fleet. */
export function FleetGlanceSection({
  projectId,
  fleet,
}: {
  projectId: string;
  fleet: SectionState<FleetView>;
}) {
  return (
    <Section
      title="Fleet"
      description="What each agent is doing now."
      pad="none"
      actions={
        <NextLink href={`/projects/${projectId}/fleet`} className={quietLink}>
          View Fleet
        </NextLink>
      }
    >
      <AsyncSection
        section={fleet}
        unavailable={{
          title: 'The fleet could not be loaded',
          stillWorks: 'The rest of the project is still available.',
        }}
        isEmpty={(view) =>
          view.slots.filter((slot) => slot.status !== 'ended').length === 0
        }
        empty={<Quiet>No agent is running on this project.</Quiet>}
        skeleton={<Skeleton className="m-4 h-24" />}
      >
        {(view) => {
          const live = view.slots.filter((slot) => slot.status !== 'ended');
          return (
            <ul className="divide-y divide-line">
              {live.slice(0, FLEET_ROWS).map((slot) => (
                <li key={slot.id}>
                  <NextLink
                    href={slotHref(projectId, slot.name)}
                    className={ROW}
                  >
                    <Badge dot hue={slotHue(slot.name)} aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-sm font-medium">
                        {slot.name}
                      </span>
                      <span className="block truncate text-xs text-ink-3">
                        {[
                          slot.issue === null ? null : `#${slot.issue}`,
                          checkpointLabel(slot.lastCheckpoint),
                        ]
                          .filter((part) => part && part !== '—')
                          .join(' · ') || 'No issue yet'}
                      </span>
                    </span>
                    <StatusPill
                      size="md"
                      status={SLOT_PILL_STATUS[slot.status]}
                      label={SLOT_STATUS_LABEL[slot.status]}
                    />
                  </NextLink>
                </li>
              ))}
              {live.length > FLEET_ROWS ? (
                <li className="px-4 py-3 text-xs text-ink-3">
                  {live.length - FLEET_ROWS} more on the Fleet.
                </li>
              ) : null}
            </ul>
          );
        }}
      </AsyncSection>
    </Section>
  );
}

/** The project's latest events, each opening what it is about. */
export function RecentActivitySection({
  projectId,
  activity,
}: {
  projectId: string;
  activity: SectionState<ActivityPage>;
}) {
  return (
    <Section
      title="Recent activity"
      description="The latest events on this project."
      pad="none"
      actions={
        <NextLink
          href={`/projects/${projectId}/activity`}
          className={quietLink}
        >
          Open Activity
        </NextLink>
      }
    >
      <AsyncSection
        section={activity}
        unavailable={{
          title: 'Activity could not be loaded',
          stillWorks: 'The rest of the project is still available.',
        }}
        isEmpty={(page) => page.items.length === 0}
        empty={<Quiet>Nothing has happened yet.</Quiet>}
        skeleton={<Skeleton className="m-4 h-24" />}
      >
        {(page) => (
          <ul className="divide-y divide-line">
            {page.items.map((item) => {
              const href = activityHref(item);
              const body = (
                <>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {itemTitle(item).title}
                  </span>
                  <span className="text-xs whitespace-nowrap text-ink-3">
                    <Time value={item.ts} />
                  </span>
                </>
              );
              return (
                <li key={item.id}>
                  {href ? (
                    <NextLink href={href} className={ROW}>
                      {body}
                    </NextLink>
                  ) : (
                    <div className={ROW}>{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </AsyncSection>
    </Section>
  );
}
