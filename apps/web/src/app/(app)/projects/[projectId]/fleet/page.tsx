'use client';

import {
  FLEET_LIVE_EVENT,
  type FleetView,
  type ProjectDetail,
  projectRoleAtLeast,
  type Role,
  SLOT_STATUSES,
  type SlotPage,
  type SlotStatus,
  type SlotSummary,
} from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Button } from 'glass-ui/button';
import { EmptyState } from 'glass-ui/empty-state';
import { Field, Input, Select } from 'glass-ui/field';
import { Skeleton } from 'glass-ui/skeleton';
import { toast } from 'glass-ui/toast';
import { Toggle } from 'glass-ui/toggle';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TerminalSheet } from '../../../../../components/terminal/terminal-sheet';
import type { TerminalTarget } from '../../../../../components/terminal/terminal-view';
import { api } from '../../../../../lib/api';
import { useControl } from '../../../../../lib/control/use-control';
import {
  describeFleetError,
  isNotFound,
  parseIssueFilter,
  slotsQuery,
} from '../../../../../lib/fleet/format';
import { useLive, useLiveStatus } from '../../../../../lib/live/use-live';
import { useTerminalAvailable } from '../../../../../lib/terminal/use-terminal-available';
import { OrchestratorCard } from './orchestrator-card';
import { SlotSheet } from './slot-sheet';
import { SlotsTable } from './slots-table';

const PAGE_SIZE = 50;
/** Pushes arrive in bursts (one per projected batch); one refetch covers them. */
const REFETCH_DEBOUNCE_MS = 300;
/** Ages in the table are relative to now. */
const AGE_TICK_MS = 30_000;

export default function FleetPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [fleet, setFleet] = useState<FleetView>();
  const [missing, setMissing] = useState(false);
  /** Bumped by a live push; every fetch effect depends on it. */
  const [version, setVersion] = useState(0);
  const [, setNow] = useState(0);

  const [showAll, setShowAll] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [issueText, setIssueText] = useState('');
  const [history, setHistory] = useState<SlotSummary[]>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [selected, setSelected] = useState<string>();

  const [role, setRole] = useState<Role>('viewer');
  const [runnerId, setRunnerId] = useState<string>();
  const [attach, setAttach] = useState<{
    target: TerminalTarget;
    title: string;
  }>();
  const control = useControl(projectId);
  const canAttach = useTerminalAvailable(runnerId, role === 'admin');

  // The effective role only decides which buttons are drawn; the API checks it.
  useEffect(() => {
    api<ProjectDetail>(`/projects/${projectId}`)
      .then((project) => {
        setRole(project.role);
        setRunnerId(project.runnerId);
      })
      .catch(() => setRole('viewer'));
  }, [projectId]);

  const live = useLiveStatus();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useLive(`project:${projectId}`, (message) => {
    if (message.event !== FLEET_LIVE_EVENT) return;
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: version is a refetch trigger
  useEffect(() => {
    let cancelled = false;
    api<FleetView>(`/projects/${projectId}/fleet`)
      .then((view) => {
        if (cancelled) return;
        setFleet(view);
        setMissing(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isNotFound(err)) setMissing(true);
        else toast.error(describeFleetError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, version]);

  const status = SLOT_STATUSES.find((s) => s === statusFilter);
  const issue = parseIssueFilter(issueText);

  // The "all slots" view: first page for the filters, refetched on a push.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version is a refetch trigger
  useEffect(() => {
    if (!showAll) return;
    let cancelled = false;
    api<SlotPage>(
      `/projects/${projectId}/slots${slotsQuery({ status, issue, limit: PAGE_SIZE })}`,
    )
      .then((page) => {
        if (cancelled) return;
        setHistory(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setHistory([]);
        setNextCursor(null);
        toast.error(describeFleetError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, showAll, status, issue, version]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api<SlotPage>(
        `/projects/${projectId}/slots${slotsQuery({ status, issue, cursor: nextCursor, limit: PAGE_SIZE })}`,
      );
      setHistory((current) => [...(current ?? []), ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      toast.error(describeFleetError(err));
    } finally {
      setLoadingMore(false);
    }
  }, [projectId, nextCursor, status, issue]);

  if (missing) {
    return (
      <EmptyState
        title="Project not found"
        description="It was removed, or you are not a member of it."
      />
    );
  }
  if (!fleet) return <Skeleton className="h-64 w-full" />;

  const slots = showAll ? history : fleet.slots;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Fleet</h1>
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

      <OrchestratorCard
        fleet={fleet}
        projectId={projectId}
        control={control}
        role={role}
        onAttach={
          canAttach
            ? () =>
                setAttach({
                  target: { kind: 'orchestrator' },
                  title: 'Orchestrator',
                })
            : undefined
        }
      />

      <section className="flex flex-col gap-4" aria-label="Slots">
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex items-center gap-2 text-sm">
            <Toggle
              labelledBy="fleet-show-ended"
              checked={showAll}
              onChange={(checked) => {
                setShowAll(checked);
                setHistory(undefined);
              }}
            />
            <span id="fleet-show-ended">Show ended</span>
          </div>
          {showAll ? (
            <>
              <Field label="Status" htmlFor="fleet-status">
                <Select
                  id="fleet-status"
                  value={statusFilter}
                  onChange={(e) => {
                    setStatusFilter(e.target.value);
                    setHistory(undefined);
                  }}
                >
                  <option value="">Any status</option>
                  {SLOT_STATUSES.map((s: SlotStatus) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Issue" htmlFor="fleet-issue">
                <Input
                  id="fleet-issue"
                  value={issueText}
                  inputMode="numeric"
                  placeholder="e.g. 42"
                  maxLength={10}
                  onChange={(e) => {
                    setIssueText(e.target.value);
                    setHistory(undefined);
                  }}
                />
              </Field>
            </>
          ) : null}
        </div>

        {slots === undefined ? (
          <Skeleton className="h-40 w-full" />
        ) : slots.length === 0 ? (
          <EmptyState
            title={showAll ? 'No slots' : 'No active slots'}
            description={
              showAll
                ? 'Nothing matches these filters.'
                : 'Slots appear here once the orchestrator dispatches a round on this project.'
            }
          />
        ) : (
          <>
            <SlotsTable slots={slots} onSelect={(s) => setSelected(s.name)} />
            {showAll && nextCursor ? (
              <div className="flex justify-center">
                <Button
                  variant="glass"
                  disabled={loadingMore}
                  onClick={loadMore}
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </section>

      <SlotSheet
        projectId={projectId}
        name={selected}
        version={version}
        control={control}
        canOperate={projectRoleAtLeast(role, 'operator')}
        onClose={() => setSelected(undefined)}
        onAttach={
          canAttach
            ? (name) =>
                setAttach({ target: { kind: 'slot', slot: name }, title: name })
            : undefined
        }
      />

      <TerminalSheet
        projectId={projectId}
        target={attach?.target}
        title={attach?.title ?? ''}
        onClose={() => setAttach(undefined)}
      />
    </div>
  );
}
