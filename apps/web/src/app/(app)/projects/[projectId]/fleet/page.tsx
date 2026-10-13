'use client';

import {
  FLEET_LIVE_EVENT,
  type FleetView,
  type OrchestratorSettingsView,
  projectRoleAtLeast,
  SLOT_STATUSES,
  type SlotPage,
  type SlotStatus,
  type SlotSummary,
} from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Field, Input, Select } from '@andrewbehma/glass-ui/field';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { BudgetExceededBanner } from '../../../../../components/budgets/exceeded-banner';
import { AsyncSection } from '../../../../../components/prerequisites/async-section';
import { RunnerOfflineBanner } from '../../../../../components/prerequisites/prerequisite-banner';
import { LiveStatusBadge } from '../../../../../components/shell/live-status-badge';
import { TerminalSheet } from '../../../../../components/terminal/terminal-sheet';
import type { TerminalTarget } from '../../../../../components/terminal/terminal-view';
import { api } from '../../../../../lib/api';
import { useControl } from '../../../../../lib/control/use-control';
import {
  EMPTY_FLEET_DESCRIPTION,
  isNotFound,
  parseIssueFilter,
  slotStatusOptions,
  slotsQuery,
} from '../../../../../lib/fleet/format';
import { useLive } from '../../../../../lib/live/use-live';
import { useSection } from '../../../../../lib/section/use-section';
import { useTerminalAvailable } from '../../../../../lib/terminal/use-terminal-available';
import { useProjectDetail } from '../use-project-detail';
import { OrchestratorCard } from './orchestrator-card';
import { SlotSheet } from './slot-sheet';
import { SlotsTable } from './slots-table';
import { useControlReasons } from './use-control-reasons';

const PAGE_SIZE = 50;
/** Pushes arrive in bursts (one per projected batch); one refetch covers them. */
const REFETCH_DEBOUNCE_MS = 300;
/** Ages in the table are relative to now. */
const AGE_TICK_MS = 30_000;

export default function FleetPage() {
  const { projectId } = useParams<{ projectId: string }>();
  /** Bumped by a live push; the fleet and the slot list depend on it. */
  const [version, setVersion] = useState(0);
  const [, setNow] = useState(0);

  const [showAll, setShowAll] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [issueText, setIssueText] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);

  const [selected, setSelected] = useState<string>();
  const [startOpen, setStartOpen] = useState(false);

  const [attach, setAttach] = useState<{
    target: TerminalTarget;
    title: string;
  }>();

  const detail = useProjectDetail(projectId);
  const project = detail.data;
  // The effective role only decides which buttons are drawn; the API checks it.
  const role = project?.role ?? 'viewer';
  const isAdmin = role === 'admin';
  const canOperate = projectRoleAtLeast(role, 'operator');
  const control = useControl(projectId, isAdmin);
  const canAttach = useTerminalAvailable(project?.runnerId, isAdmin);

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

  const fleet = useSection(
    () => api<FleetView>(`/projects/${projectId}/fleet`),
    [projectId, version],
  );
  const settings = useSection(
    () =>
      api<OrchestratorSettingsView>(
        `/projects/${projectId}/orchestrator/settings`,
      ),
    [projectId],
  );
  const reasons = useControlReasons({
    projectId,
    isAdmin,
    project,
    settings,
    orchestrator: fleet.data?.orchestrator.status,
  });

  const status = SLOT_STATUSES.find((s) => s === statusFilter);
  const issue = parseIssueFilter(issueText);
  const filtered = status !== undefined || issue !== undefined;

  // The "all slots" view: first page for the filters, refetched on a push.
  // Nothing while the view is off, so a toggle shows a skeleton, not an empty list.
  const history = useSection<SlotPage | undefined>(
    () =>
      showAll
        ? api<SlotPage>(
            `/projects/${projectId}/slots${slotsQuery({ status, issue, limit: PAGE_SIZE })}`,
          )
        : Promise.resolve(undefined),
    [projectId, showAll, status, issue, version],
  );

  const loadMore = async () => {
    const cursor = history.data?.nextCursor;
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await api<SlotPage>(
        `/projects/${projectId}/slots${slotsQuery({ status, issue, cursor, limit: PAGE_SIZE })}`,
      );
      history.setData((current) =>
        current
          ? {
              items: [...current.items, ...page.items],
              nextCursor: page.nextCursor,
            }
          : current,
      );
    } catch {
      // The list stays as it is; the button is still there to try again.
    } finally {
      setLoadingMore(false);
    }
  };

  if (fleet.data === undefined && isNotFound(fleet.error)) {
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

  const nobodyYet = (
    <EmptyState
      title="No active slots"
      description={EMPTY_FLEET_DESCRIPTION}
      action={
        canOperate && reasons.start === null ? (
          <Button variant="solid" onClick={() => setStartOpen(true)}>
            Start the orchestrator
          </Button>
        ) : (
          <Link
            href={`/projects/${projectId}/queue`}
            className="text-sm underline"
          >
            Open Queue
          </Link>
        )
      }
    />
  );

  const clearFilters = () => {
    setStatusFilter('');
    setIssueText('');
  };

  const slotsList = (slots: SlotSummary[]) => (
    <SlotsTable slots={slots} onSelect={(s) => setSelected(s.name)} />
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">Fleet</h1>
          <LiveStatusBadge />
        </div>
        {project ? <RunnerOfflineBanner project={project} /> : null}
      </div>

      <BudgetExceededBanner projectId={projectId} />

      <AsyncSection
        section={fleet}
        unavailable={{
          title: 'The fleet could not be loaded',
          stillWorks: 'The rest of the project is still available.',
        }}
        empty={null}
        isEmpty={() => false}
        skeleton={<Skeleton className="h-64 w-full" />}
      >
        {(view) => (
          <>
            <OrchestratorCard
              fleet={view}
              projectId={projectId}
              control={control}
              canOperate={canOperate}
              isAdmin={isAdmin}
              settings={settings}
              reasons={reasons}
              startOpen={startOpen}
              onStartOpenChange={setStartOpen}
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
                    onChange={setShowAll}
                  />
                  <span id="fleet-show-ended">Show ended</span>
                </div>
                {showAll ? (
                  <>
                    <Field label="Status" htmlFor="fleet-status">
                      <Select
                        id="fleet-status"
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value)}
                      >
                        <option value="">Any status</option>
                        {slotStatusOptions().map(
                          (o: { value: SlotStatus; label: string }) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ),
                        )}
                      </Select>
                    </Field>
                    <Field label="Issue" htmlFor="fleet-issue">
                      <Input
                        id="fleet-issue"
                        value={issueText}
                        inputMode="numeric"
                        placeholder="e.g. 42"
                        maxLength={10}
                        onChange={(e) => setIssueText(e.target.value)}
                      />
                    </Field>
                  </>
                ) : null}
              </div>

              {showAll ? (
                <AsyncSection
                  section={history}
                  unavailable={{
                    title: 'Slots could not be loaded',
                    stillWorks: 'The active slots above are still current.',
                  }}
                  isEmpty={(page) =>
                    page === undefined || page.items.length === 0
                  }
                  empty={
                    filtered ? (
                      <EmptyState
                        title="No matching slots"
                        description="No slot matches these filters."
                        action={
                          <Button variant="glass" onClick={clearFilters}>
                            Clear filters
                          </Button>
                        }
                      />
                    ) : (
                      <EmptyState
                        title="No slots yet"
                        description={EMPTY_FLEET_DESCRIPTION}
                        action={
                          <Link
                            href={`/projects/${projectId}/queue`}
                            className="text-sm underline"
                          >
                            Open Queue
                          </Link>
                        }
                      />
                    )
                  }
                  skeleton={<Skeleton className="h-40 w-full" />}
                >
                  {(page) => (
                    <>
                      {slotsList(page?.items ?? [])}
                      {page?.nextCursor ? (
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
                </AsyncSection>
              ) : view.slots.length === 0 ? (
                nobodyYet
              ) : (
                slotsList(view.slots)
              )}
            </section>
          </>
        )}
      </AsyncSection>

      <SlotSheet
        projectId={projectId}
        name={selected}
        version={version}
        control={control}
        canOperate={canOperate}
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
