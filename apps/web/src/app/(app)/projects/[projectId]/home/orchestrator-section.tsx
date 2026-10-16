'use client';

import type {
  ActivityPage,
  FleetGraph,
  FleetView,
  ProjectDetail,
} from '@agentdock/shared';
import { buttonClassName } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { Disclosure } from '@andrewbehma/glass-ui/disclosure';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { KeyValueList } from '@andrewbehma/glass-ui/key-value-list';
import { SectionUnavailable } from '@andrewbehma/glass-ui/section-unavailable';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { StatusDot, StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { ChevronDown, ExternalLink, Network } from 'lucide-react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { activityHref, itemTitle } from '../../../../../lib/activity/format';
import type { useControl } from '../../../../../lib/control/use-control';
import {
  formatAge,
  formatOccupancy,
  formatRoundHeader,
  ORCHESTRATOR_STATUS_LABEL,
} from '../../../../../lib/fleet/format';
import {
  EMPTY_WORKSPACE,
  openSlot,
  toSearch,
} from '../../../../../lib/fleet/workspace-url';
import { formatNumber } from '../../../../../lib/format';
import { Time } from '../../../../../lib/format/time';
import type { Section } from '../../../../../lib/section/use-section';
import {
  ORCHESTRATOR_PILL_STATUS,
  SLOT_PILL_STATUS,
} from '../../../../../lib/status/pill';
import { AgentCanvas, AgentList } from '../fleet/agent-canvas';

/** More dots than this is a number, not a glance. */
const DOTS_MAX = 12;
const MESSAGE_ON_FLEET = 'Open the fleet to message the orchestrator.';

/** The slots at a glance: one status dot each, empty seats as hollow ones. */
function SlotDots({ fleet }: { fleet: FleetView }) {
  const max = fleet.latestRound?.max ?? fleet.slots.length;
  const shown = fleet.slots.slice(0, DOTS_MAX);
  const free = Math.max(0, Math.min(max, DOTS_MAX) - shown.length);
  return (
    <span className="flex items-center gap-1" aria-hidden="true">
      {shown.map((slot) => (
        <StatusDot key={slot.id} status={SLOT_PILL_STATUS[slot.status]} />
      ))}
      {Array.from({ length: free }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: empty seats have no identity
          key={i}
          className="size-2 rounded-full border border-line-strong"
        />
      ))}
    </span>
  );
}

/** The disclosure's row: what the orchestrator does, without opening it. */
function Summary({
  fleet,
  project,
  queued,
  open,
}: {
  fleet: Section<FleetView>;
  project: ProjectDetail | undefined;
  queued: number | undefined;
  open: boolean;
}) {
  const view = fleet.data;
  const status = view?.orchestrator.status;
  const since = view?.orchestrator.since;
  const round = view?.latestRound;
  return (
    <span className="flex w-full min-w-0 items-center gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-control border border-line bg-raised text-ink-2">
        <Network aria-hidden="true" className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          <span id="project-orchestrator">Orchestrator</span>
          {status ? (
            <StatusPill
              status={ORCHESTRATOR_PILL_STATUS[status]}
              label={
                since && status !== 'unknown'
                  ? `${ORCHESTRATOR_STATUS_LABEL[status]} · ${formatAge(since)}`
                  : ORCHESTRATOR_STATUS_LABEL[status]
              }
            />
          ) : fleet.error !== null ? (
            <span className="font-normal text-ink-3">Not answering</span>
          ) : (
            <Skeleton className="h-5 w-24" />
          )}
        </span>
        <span className="truncate text-xs font-normal text-ink-3">
          {[
            project?.runnerName,
            round
              ? `round ${formatRoundHeader(round.date, round.label)}`
              : null,
          ]
            .filter(Boolean)
            .join(' · ') || 'No round yet'}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-4 text-xs font-normal text-ink-2">
        {view ? (
          <>
            <span className="hidden items-center gap-2 sm:flex">
              <SlotDots fleet={view} />
              <span>
                <b className="num font-semibold text-ink">
                  {formatOccupancy(view.slots.length, view.latestRound)}
                </b>{' '}
                slots busy
              </span>
            </span>
            {queued !== undefined ? (
              <span className="hidden md:inline">
                <b className="num font-semibold text-ink">
                  {formatNumber(queued)}
                </b>{' '}
                queued
              </span>
            ) : null}
          </>
        ) : null}
        <span className="hidden lg:inline">
          {open ? 'Collapse' : 'Expand to see the live graph'}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`size-4 shrink-0 transition-transform duration-(--dur-base) motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
        />
      </span>
    </span>
  );
}

/** The newest things that happened on the project, as a short live log. */
function LiveLog({ activity }: { activity: Section<ActivityPage> }) {
  if (!activity.data) {
    return activity.error !== null ? (
      <p className="text-sm text-ink-3">Activity is not answering.</p>
    ) : (
      <Skeleton className="h-32 w-full" />
    );
  }
  if (activity.data.items.length === 0) {
    return <p className="text-sm text-ink-3">Nothing happened yet.</p>;
  }
  return (
    <ul className="-mx-2 flex flex-col font-mono text-xs">
      {activity.data.items.map((item) => {
        const href = activityHref(item);
        const body = (
          <>
            <Time
              value={item.ts}
              className="shrink-0 whitespace-nowrap text-ink-3"
            />
            <span className="min-w-0 flex-1 truncate">
              {itemTitle(item).title}
            </span>
          </>
        );
        const row = 'flex items-baseline gap-3 rounded-md px-2 py-1';
        return (
          <li key={item.id}>
            {href ? (
              <NextLink href={href} className={`${row} hover:bg-hover`}>
                {body}
              </NextLink>
            ) : (
              <div className={row}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The orchestrator, folded (card C-6): its state, the slots at a glance and
 * the queue in one row; opened, the agent tree, its facts and a live log.
 * Fleet stays the place to steer it — every node opens there.
 */
export function OrchestratorSection({
  projectId,
  project,
  open,
  onOpenChange,
  fleet,
  graph,
  activity,
  queued,
  desktop,
  control,
  canOperate,
}: {
  projectId: string;
  project: ProjectDetail | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fleet: Section<FleetView>;
  /** Asked for only while open. */
  graph: Section<FleetGraph | undefined>;
  activity: Section<ActivityPage>;
  queued: number | undefined;
  desktop: boolean;
  control: ReturnType<typeof useControl>;
  canOperate: boolean;
}) {
  const router = useRouter();
  // Kept once opened, so closing animates instead of emptying the panel first.
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  const fleetHref = `/projects/${projectId}/fleet`;
  const openOnFleet = (key: string) =>
    router.push(`${fleetHref}${toSearch(openSlot(EMPTY_WORKSPACE, key))}`);
  const view = fleet.data;
  const round = view?.latestRound;

  const tree = () => {
    if (graph.data === undefined) {
      return graph.error !== null ? (
        <SectionUnavailable
          title="The agent tree could not be loaded"
          stillWorks="The fleet still shows every slot."
        />
      ) : (
        <Skeleton className="h-96 w-full" />
      );
    }
    if (graph.data.nodes.length <= 1) {
      return (
        <EmptyState
          title="Nothing is running"
          description="Once the orchestrator dispatches an issue, its slot appears here."
          link={NextLink}
          action={{ label: 'Open Fleet', href: fleetHref }}
        />
      );
    }
    const props = {
      graph: graph.data,
      focus: null,
      control,
      canOperate,
      orchestratorMessageReason: MESSAGE_ON_FLEET,
      onOpen: openOnFleet,
    };
    return desktop ? <AgentCanvas {...props} /> : <AgentList {...props} />;
  };

  return (
    <section aria-labelledby="project-orchestrator">
      <Disclosure
        open={open}
        onOpenChange={onOpenChange}
        triggerClassName="hover:bg-hover rounded-surface"
        trigger={
          <Summary
            fleet={fleet}
            project={project}
            queued={queued}
            open={open}
          />
        }
      >
        {/* Mounted on first open: the canvas measures itself on mount. */}
        {opened ? (
          <div className="flex flex-col gap-4 border-t border-line pt-4">
            <div className="flex items-center justify-end gap-2">
              <NextLink
                href={fleetHref}
                className={buttonClassName({ variant: 'ghost', size: 'sm' })}
              >
                Open fleet
                <ExternalLink aria-hidden="true" className="size-4" />
              </NextLink>
            </div>
            <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
              <div className="min-w-0">{tree()}</div>
              <div className="flex min-w-0 flex-col gap-4">
                <Card pad="md" className="flex flex-col gap-3">
                  <h3 className="flex items-center gap-2 text-sm font-semibold">
                    Orchestrator
                    {view ? (
                      <StatusPill
                        status={
                          ORCHESTRATOR_PILL_STATUS[view.orchestrator.status]
                        }
                        label={
                          ORCHESTRATOR_STATUS_LABEL[view.orchestrator.status]
                        }
                      />
                    ) : null}
                  </h3>
                  <KeyValueList
                    dense
                    columns={1}
                    items={[
                      {
                        key: 'runner',
                        label: 'Runner',
                        value: project?.runnerName ?? '—',
                      },
                      {
                        key: 'since',
                        label: 'Since',
                        value: view?.orchestrator.since ? (
                          <Time value={view.orchestrator.since} />
                        ) : (
                          '—'
                        ),
                      },
                      {
                        key: 'round',
                        label: 'Round',
                        value: round
                          ? formatRoundHeader(round.date, round.label)
                          : '—',
                      },
                      {
                        key: 'slots',
                        label: 'Slots',
                        value: view ? (
                          <span className="num">
                            {formatOccupancy(view.slots.length, round ?? null)}
                          </span>
                        ) : (
                          '—'
                        ),
                      },
                      {
                        key: 'base',
                        label: 'Base',
                        value: view?.base ?? '—',
                      },
                    ]}
                  />
                </Card>
                <Card pad="md" className="flex min-w-0 flex-col gap-2">
                  <h3 className="text-sm font-semibold">Live log</h3>
                  <LiveLog activity={activity} />
                </Card>
              </div>
            </div>
          </div>
        ) : null}
      </Disclosure>
    </section>
  );
}
