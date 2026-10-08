'use client';

import {
  type ProjectDetail,
  QUEUE_LIVE_EVENT,
  QUEUE_STATES,
  type QueueItemView,
  type QueueRefreshResult,
  type QueueView,
} from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Button } from 'glass-ui/button';
import { ChipButton } from 'glass-ui/chip';
import { EmptyState } from 'glass-ui/empty-state';
import {
  SegmentedControl,
  SegmentedControlItem,
} from 'glass-ui/segmented-control';
import { Skeleton } from 'glass-ui/skeleton';
import { toast } from 'glass-ui/toast';
import { Toolbar } from 'glass-ui/toolbar';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../../../lib/api';
import { formatAgo } from '../../../../../lib/fleet/format';
import { useLive, useLiveStatus } from '../../../../../lib/live/use-live';
import {
  allowedLabels,
  countByState,
  describeQueueError,
  filterItems,
  isNotFound,
  type StateFilter,
  stateLabel,
} from '../../../../../lib/queue/format';
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
  const [queue, setQueue] = useState<QueueView>();
  const [role, setRole] = useState<ProjectDetail['role']>();
  const [missing, setMissing] = useState(false);
  /** Bumped by a live push; every fetch effect depends on it. */
  const [version, setVersion] = useState(0);
  const [, setNow] = useState(0);

  const [view, setView] = useState<View>('list');
  const [filter, setFilter] = useState<StateFilter>('all');
  const [selected, setSelected] = useState<QueueItemView>();
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const live = useLiveStatus();
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
  useEffect(() => {
    let cancelled = false;
    api<ProjectDetail>(`/projects/${projectId}`)
      .then((project) => {
        if (!cancelled) setRole(project.role);
      })
      .catch(() => {
        if (!cancelled) setRole('viewer');
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version is a refetch trigger
  useEffect(() => {
    let cancelled = false;
    api<QueueView>(`/projects/${projectId}/queue?include=open`)
      .then((next) => {
        if (cancelled) return;
        setQueue(next);
        setMissing(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isNotFound(err)) setMissing(true);
        else toast.error(describeQueueError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, version]);

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
      toast.error(describeQueueError(err));
    } finally {
      setRefreshing(false);
    }
  }, [projectId]);

  if (missing) {
    return (
      <EmptyState
        title="Project not found"
        description="It was removed, or you are not a member of it."
      />
    );
  }
  if (!queue) return <Skeleton className="h-64 w-full" />;

  const canOperate = role !== undefined && role !== 'viewer';
  const counts = countByState(queue.items);
  const items = filterItems(queue.items, filter);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Queue</h1>
          <p className="text-sm text-ink-2">
            Open issues labelled <code>{queue.readyLabel}</code>
            {queue.snapshotAt
              ? ` · snapshot ${formatAgo(queue.snapshotAt)}`
              : ' · no snapshot yet'}
          </p>
        </div>
        <span className="inline-flex items-center gap-2 text-xs text-ink-2">
          <Badge
            dot
            tone={live.status === 'connected' ? 'ok' : 'warn'}
            aria-hidden="true"
          />
          {live.status === 'connected'
            ? 'Live'
            : live.status === 'reconnecting'
              ? 'Reconnecting…'
              : 'Offline'}
        </span>
      </div>

      {queue.unavailable ? (
        <p role="alert" className="text-sm text-warn">
          The runner cannot read this project’s issues:{' '}
          {queue.unavailable.reason}
        </p>
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
                  className="w-full px-3 py-1.5 text-sm capitalize"
                  onClick={() => setView(v)}
                >
                  {v}
                </button>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        }
        actions={
          canOperate ? (
            <>
              <Button variant="glass" disabled={refreshing} onClick={refresh}>
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </Button>
              <Button onClick={() => setCreating(true)}>New issue</Button>
            </>
          ) : undefined
        }
      />

      {view === 'list' ? (
        <fieldset className="m-0 grid min-w-0 grid-cols-2 gap-2 border-0 p-0 sm:grid-cols-3 lg:grid-cols-6">
          <legend className="sr-only">Filter by state</legend>
          <ChipButton
            selected={filter === 'all'}
            onClick={() => setFilter('all')}
          >
            All {queue.items.length}
          </ChipButton>
          {QUEUE_STATES.map((state) => (
            <ChipButton
              key={state}
              selected={filter === state}
              onClick={() => setFilter(filter === state ? 'all' : state)}
            >
              {stateLabel(state)} {counts[state]}
            </ChipButton>
          ))}
        </fieldset>
      ) : null}

      {queue.items.length === 0 ? (
        <EmptyState
          title="The queue is empty"
          description={`No open issue carries ${queue.readyLabel}${queue.snapshotAt ? '' : ', and the runner has not sent its first snapshot yet'}.`}
        />
      ) : view === 'board' ? (
        <QueueBoard items={queue.items} onSelect={setSelected} />
      ) : items.length === 0 ? (
        <EmptyState
          title="Nothing in this state"
          description="No queued issue is in the state you filtered by."
        />
      ) : (
        <QueueList items={items} onSelect={setSelected} />
      )}

      <HeldForLead rows={queue.heldForLead} />

      {queue.round ? (
        <p className="text-xs text-ink-3">
          Orchestrator verdicts from round {queue.round.date}{' '}
          {queue.round.round}.
        </p>
      ) : null}

      <IssueSheet
        projectId={projectId}
        number={selected?.number}
        title={selected?.title}
        version={version}
        onClose={() => setSelected(undefined)}
      />

      {canOperate ? (
        <NewIssueDialog
          projectId={projectId}
          open={creating}
          labelChoices={allowedLabels(queue)}
          onOpenChange={setCreating}
          onCreated={() => setVersion((v) => v + 1)}
        />
      ) : null}
    </div>
  );
}
