'use client';

import {
  APPROVALS_LIVE_EVENT,
  type ApprovalsView,
  QUEUE_LIVE_EVENT,
  QUEUE_STATES,
  type QueueItemView,
  type QueueRefreshResult,
  type QueueView,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { ChipButton } from '@andrewbehma/glass-ui/chip';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@andrewbehma/glass-ui/segmented-control';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { Tab, TabGroup, TabList, TabPanel } from '@andrewbehma/glass-ui/tabs';
import { toast } from '@andrewbehma/glass-ui/toast';
import { Toolbar } from '@andrewbehma/glass-ui/toolbar';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import { CirclePlus, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { PageHeader } from '../../../../../components/page-header/page-header';
import { AsyncSection } from '../../../../../components/prerequisites/async-section';
import {
  PrerequisiteBanner,
  RunnerOfflineBanner,
} from '../../../../../components/prerequisites/prerequisite-banner';
import { useLivePaused } from '../../../../../components/shell/live-status';
import { LiveStatusBadge } from '../../../../../components/shell/live-status-badge';
import { usePageActions } from '../../../../../components/shell/use-page-actions';
import { api } from '../../../../../lib/api';
import { pendingApprovalCount } from '../../../../../lib/approvals/needs-you';
import { useActionRequests } from '../../../../../lib/approvals/use-action-requests';
import { useUrlFilters } from '../../../../../lib/filters/use-url-filters';
import { Time } from '../../../../../lib/format/time';
import { useLive } from '../../../../../lib/live/use-live';
import { useTabParam } from '../../../../../lib/projects/use-tab-param';
import {
  allowedLabels,
  countByState,
  describeQueueError,
  filterItems,
  isNotFound,
  QUEUE_FILTER_CODEC,
  type QueueFilters,
  queueEmptyDescription,
  queueUnavailableCopy,
  roundFooter,
  STATE_CHIP_LABEL,
  type StateFilter,
} from '../../../../../lib/queue/format';
import { QUEUE_TABS, type QueueTab } from '../../../../../lib/queue/tabs';
import { useSection } from '../../../../../lib/section/use-section';
import { useProjectDetail } from '../use-project-detail';
import { ApprovalsTab } from './approvals-tab';
import { HeldForLead } from './held-for-lead';
import { IssueSheet } from './issue-sheet';
import { NewIssueDialog } from './new-issue-dialog';
import { QueueBoard } from './queue-board';
import { QueueList } from './queue-list';

/** Pushes arrive in bursts (one per projected batch); one refetch covers them. */
const REFETCH_DEBOUNCE_MS = 300;
/** "Snapshot 3 min ago" is relative to now. */
const AGE_TICK_MS = 30_000;

/** A selected filter chip wears the accent, not solid ink (#213). */
const SELECTED_CHIP = 'bg-accent-soft text-accent-ink';

export default function QueuePage() {
  // `useSearchParams` needs a boundary for the static shell.
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <QueueScreen />
    </Suspense>
  );
}

function QueueScreen() {
  const { projectId } = useParams<{ projectId: string }>();
  /** Bumped by a live push; the queue and the issue sheet depend on it. */
  const [version, setVersion] = useState(0);
  /** The same for the approvals and the open approval's detail. */
  const [approvalsVersion, setApprovalsVersion] = useState(0);
  const [tab, setTab] = useTabParam(QUEUE_TABS);
  const [, setNow] = useState(0);

  // The state chip and the view live in the URL: reload and a link keep them.
  const { filters, set } = useUrlFilters(QUEUE_FILTER_CODEC);
  const { view, state: filter } = filters;
  const setView = (next: QueueFilters['view']) => set({ view: next });
  const setFilter = (next: StateFilter) => set({ state: next });
  const [selected, setSelected] = useState<QueueItemView>();
  const live = useLivePaused();
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const approvalsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useLive(`project:${projectId}`, (message) => {
    const target =
      message.event === QUEUE_LIVE_EVENT
        ? { timer, bump: setVersion }
        : message.event === APPROVALS_LIVE_EVENT
          ? { timer: approvalsTimer, bump: setApprovalsVersion }
          : undefined;
    if (!target) return;
    clearTimeout(target.timer.current);
    target.timer.current = setTimeout(
      () => target.bump((v) => v + 1),
      REFETCH_DEBOUNCE_MS,
    );
  });
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      clearTimeout(approvalsTimer.current);
    },
    [],
  );

  useEffect(() => {
    const id = setInterval(() => setNow((n) => n + 1), AGE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // The role gates the buttons; the API stays the authority (403 on a viewer).
  const project = useProjectDetail(projectId).data;
  const role = project?.role ?? 'viewer';
  const canOperate = role !== 'viewer';
  const isAdmin = role === 'admin';

  // The capsule's `+` below `lg` (#521) opens what the header's button opens.
  usePageActions([
    {
      id: 'new-issue',
      label: 'New issue',
      icon: CirclePlus,
      onSelect: () => setCreating(true),
      operatorOnly: true,
    },
  ]);

  const queue = useSection(
    () => api<QueueView>(`/projects/${projectId}/queue?include=open`),
    [projectId, version],
  );
  // Loaded on either tab: the Approvals tab carries their count.
  const approvals = useSection(
    () => api<ApprovalsView>(`/projects/${projectId}/approvals`),
    [projectId, approvalsVersion],
  );
  const actionRequests = useActionRequests(projectId);
  const pending = pendingApprovalCount(approvals.data, actionRequests.data);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await api<QueueRefreshResult>(
        `/projects/${projectId}/queue/refresh`,
        { method: 'POST' },
      );
      toast.success(
        result.changed
          ? 'The runner polled GitHub; the queue changed.'
          : 'The runner polled GitHub; nothing changed.',
      );
      setVersion((v) => v + 1);
    } catch (err) {
      toast.error(describeQueueError(err, project?.runnerName));
    } finally {
      setRefreshing(false);
    }
  }, [projectId, project?.runnerName]);

  if (queue.data === undefined && isNotFound(queue.error)) {
    return (
      <EmptyState
        title="Project not found"
        description="It was removed, or you are not a member of it."
        action={
          <Link href="/projects" className="text-sm text-accent-ink underline">
            Open Projects
          </Link>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <PageHeader
          className="mb-0"
          title="Queue"
          description="What the orchestrator runs next, and what is waiting on your decision."
          actions={
            <>
              {/* The top bar's dot says "live"; the page speaks only when it is not. */}
              {live.status !== 'connected' ? <LiveStatusBadge /> : null}
              {canOperate ? (
                <Button variant="solid" onClick={() => setCreating(true)}>
                  New issue
                </Button>
              ) : null}
            </>
          }
        />
        {project ? <RunnerOfflineBanner project={project} /> : null}
      </div>

      <TabGroup value={tab} onValueChange={(next) => setTab(next as QueueTab)}>
        <TabList aria-label="Queue">
          <Tab value="queue">Queue</Tab>
          <Tab value="approvals">
            <span className="inline-flex items-center gap-2">
              Approvals
              {pending > 0 ? (
                <Badge
                  tone="warn"
                  count={pending}
                  aria-label={`${pending} waiting on you`}
                />
              ) : null}
            </span>
          </Tab>
        </TabList>

        <TabPanel value="queue" className="flex flex-col gap-6 pt-6">
          <AsyncSection
            section={queue}
            unavailable={{
              title: 'The queue could not be loaded',
              stillWorks: 'Fleet, approvals and history are still available.',
            }}
            empty={null}
            isEmpty={() => false}
          >
            {(data) => {
              const counts = countByState(data.items);
              const items = filterItems(data.items, filter);
              return (
                <>
                  <p className="text-sm text-ink-2">
                    Open issues labelled <code>{data.readyLabel}</code>
                    {data.snapshotAt ? (
                      <>
                        {' · snapshot '}
                        <Time value={data.snapshotAt} />
                      </>
                    ) : (
                      ' · no snapshot yet'
                    )}
                  </p>
                  {data.unavailable ? (
                    <PrerequisiteBanner
                      tone="warn"
                      {...queueUnavailableCopy(
                        data.unavailable,
                        project?.runnerName ?? null,
                        isAdmin,
                      )}
                    />
                  ) : null}

                  <Toolbar
                    aria-label="Queue controls"
                    views={
                      <SegmentedControl role="group" aria-label="View">
                        {(['list', 'board'] as const).map((v) => (
                          <SegmentedControlItem
                            key={v}
                            active={view === v}
                            layoutId="queue-view"
                          >
                            <button
                              type="button"
                              aria-pressed={view === v}
                              className="w-full min-w-16 px-3 py-1.5 text-sm whitespace-nowrap"
                              onClick={() => setView(v)}
                            >
                              {v === 'list' ? 'List' : 'Board'}
                            </button>
                          </SegmentedControlItem>
                        ))}
                      </SegmentedControl>
                    }
                    actions={
                      canOperate ? (
                        <Tooltip
                          content={
                            refreshing
                              ? 'Refreshing…'
                              : 'Refresh: ask the runner to poll GitHub'
                          }
                        >
                          <Button
                            variant="ghost"
                            icon
                            aria-label="Refresh the queue"
                            disabled={refreshing}
                            onClick={refresh}
                          >
                            <RefreshCw
                              aria-hidden="true"
                              className={`size-4 ${refreshing ? 'animate-spin' : ''}`}
                            />
                          </Button>
                        </Tooltip>
                      ) : undefined
                    }
                  />

                  {view === 'list' ? (
                    <fieldset className="m-0 min-w-0 border-0 p-0">
                      <legend className="sr-only">Filter by state</legend>
                      {/* One row that scrolls on a phone instead of wrapping into three. */}
                      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
                        <ChipButton
                          selected={filter === 'all'}
                          className={`shrink-0 ${filter === 'all' ? SELECTED_CHIP : ''}`}
                          onClick={() => setFilter('all')}
                        >
                          All{' '}
                          <Badge count={data.items.length} className="ml-1" />
                        </ChipButton>
                        {QUEUE_STATES.map((state) => (
                          <ChipButton
                            key={state}
                            selected={filter === state}
                            className={`shrink-0 ${filter === state ? SELECTED_CHIP : ''}`}
                            onClick={() =>
                              setFilter(filter === state ? 'all' : state)
                            }
                          >
                            {STATE_CHIP_LABEL[state]}{' '}
                            <Badge count={counts[state]} className="ml-1" />
                          </ChipButton>
                        ))}
                      </div>
                    </fieldset>
                  ) : null}

                  {data.items.length === 0 ? (
                    <EmptyState
                      title="The queue is empty"
                      description={queueEmptyDescription(
                        data.readyLabel,
                        data.snapshotAt,
                      )}
                      action={
                        canOperate ? (
                          <Button
                            variant="glass"
                            onClick={() => setCreating(true)}
                          >
                            New issue
                          </Button>
                        ) : undefined
                      }
                    />
                  ) : view === 'board' ? (
                    <QueueBoard items={data.items} onSelect={setSelected} />
                  ) : items.length === 0 ? (
                    <EmptyState
                      title="No matching issues"
                      description="No queued issue is in the state you filtered by."
                      action={
                        <Button
                          variant="glass"
                          onClick={() => setFilter('all')}
                        >
                          Clear filters
                        </Button>
                      }
                    />
                  ) : (
                    <QueueList items={items} onSelect={setSelected} />
                  )}

                  <HeldForLead rows={data.heldForLead} />

                  {data.round ? (
                    <p className="text-xs text-ink-3">
                      {roundFooter(data.round)}
                    </p>
                  ) : null}

                  {canOperate ? (
                    <NewIssueDialog
                      projectId={projectId}
                      open={creating}
                      labelChoices={allowedLabels(data)}
                      runnerName={project?.runnerName}
                      onOpenChange={setCreating}
                      onCreated={() => setVersion((v) => v + 1)}
                    />
                  ) : null}
                </>
              );
            }}
          </AsyncSection>
        </TabPanel>

        <TabPanel value="approvals" className="pt-6">
          <ApprovalsTab
            projectId={projectId}
            runnerName={project?.runnerName}
            canOperate={canOperate}
            approvals={approvals}
            actionRequests={actionRequests}
            version={approvalsVersion}
            onApprovalsChanged={() => setApprovalsVersion((v) => v + 1)}
          />
        </TabPanel>
      </TabGroup>

      <IssueSheet
        projectId={projectId}
        number={selected?.number}
        title={selected?.title}
        version={version}
        onClose={() => setSelected(undefined)}
      />
    </div>
  );
}
