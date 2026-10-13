'use client';

import {
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
import { toast } from '@andrewbehma/glass-ui/toast';
import { Toolbar } from '@andrewbehma/glass-ui/toolbar';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import { RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PageHeader } from '../../../../../components/page-header/page-header';
import { AsyncSection } from '../../../../../components/prerequisites/async-section';
import {
  PrerequisiteBanner,
  RunnerOfflineBanner,
} from '../../../../../components/prerequisites/prerequisite-banner';
import { LiveStatusBadge } from '../../../../../components/shell/live-status-badge';
import { api } from '../../../../../lib/api';
import { Time } from '../../../../../lib/format/time';
import { useLive } from '../../../../../lib/live/use-live';
import {
  allowedLabels,
  countByState,
  describeQueueError,
  filterItems,
  isNotFound,
  queueEmptyDescription,
  queueUnavailableCopy,
  roundFooter,
  STATE_CHIP_LABEL,
  type StateFilter,
} from '../../../../../lib/queue/format';
import { useSection } from '../../../../../lib/section/use-section';
import { useProjectDetail } from '../use-project-detail';
import { HeldForLead } from './held-for-lead';
import { IssueSheet } from './issue-sheet';
import { NewIssueDialog } from './new-issue-dialog';
import { QueueBoard } from './queue-board';
import { QueueList } from './queue-list';

/** Pushes arrive in bursts (one per projected batch); one refetch covers them. */
const REFETCH_DEBOUNCE_MS = 300;
/** "Snapshot 3 min ago" is relative to now. */
const AGE_TICK_MS = 30_000;

type View = 'list' | 'board';

export default function QueuePage() {
  const { projectId } = useParams<{ projectId: string }>();
  /** Bumped by a live push; the queue and the issue sheet depend on it. */
  const [version, setVersion] = useState(0);
  const [, setNow] = useState(0);

  const [view, setView] = useState<View>('list');
  const [filter, setFilter] = useState<StateFilter>('all');
  const [selected, setSelected] = useState<QueueItemView>();
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useLive(`project:${projectId}`, (message) => {
    if (message.event !== QUEUE_LIVE_EVENT) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setVersion((v) => v + 1),
      REFETCH_DEBOUNCE_MS,
    );
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    const id = setInterval(() => setNow((n) => n + 1), AGE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // The role gates the buttons; the API stays the authority (403 on a viewer).
  const project = useProjectDetail(projectId).data;
  const role = project?.role ?? 'viewer';
  const canOperate = role !== 'viewer';
  const isAdmin = role === 'admin';

  const queue = useSection(
    () => api<QueueView>(`/projects/${projectId}/queue?include=open`),
    [projectId, version],
  );

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
          <Link href="/projects" className="text-sm underline">
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
          description={
            queue.data ? (
              <>
                Open issues labelled <code>{queue.data.readyLabel}</code>
                {queue.data.snapshotAt ? (
                  <>
                    {' · snapshot '}
                    <Time value={queue.data.snapshotAt} />
                  </>
                ) : (
                  ' · no snapshot yet'
                )}
              </>
            ) : undefined
          }
          actions={<LiveStatusBadge />}
        />
        {project ? <RunnerOfflineBanner project={project} /> : null}
      </div>

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
                    <>
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
                      <Button variant="solid" onClick={() => setCreating(true)}>
                        New issue
                      </Button>
                    </>
                  ) : undefined
                }
              />

              {view === 'list' ? (
                <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0">
                  <legend className="sr-only">Filter by state</legend>
                  <ChipButton
                    selected={filter === 'all'}
                    onClick={() => setFilter('all')}
                  >
                    All <Badge count={data.items.length} className="ml-1" />
                  </ChipButton>
                  {QUEUE_STATES.map((state) => (
                    <ChipButton
                      key={state}
                      selected={filter === state}
                      onClick={() =>
                        setFilter(filter === state ? 'all' : state)
                      }
                    >
                      {STATE_CHIP_LABEL[state]}{' '}
                      <Badge count={counts[state]} className="ml-1" />
                    </ChipButton>
                  ))}
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
                      <Button variant="solid" onClick={() => setCreating(true)}>
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
                    <Button variant="glass" onClick={() => setFilter('all')}>
                      Clear filters
                    </Button>
                  }
                />
              ) : (
                <QueueList items={items} onSelect={setSelected} />
              )}

              <HeldForLead rows={data.heldForLead} />

              {data.round ? (
                <p className="text-xs text-ink-3">{roundFooter(data.round)}</p>
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
