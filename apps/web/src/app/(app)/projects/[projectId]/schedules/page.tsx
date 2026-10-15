'use client';

import type {
  AdminRunnerDetail,
  InstalledSkillsView,
  ScheduleView,
} from '@agentdock/shared';
import {
  SCHEDULE_FIRING_UPDATED_LIVE_EVENT,
  SCHEDULE_UPDATED_LIVE_EVENT,
} from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { toast } from '@andrewbehma/glass-ui/toast';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '../../../../../components/page-header/page-header';
import { AsyncSection } from '../../../../../components/prerequisites/async-section';
import { RunnerOfflineBanner } from '../../../../../components/prerequisites/prerequisite-banner';
import { api } from '../../../../../lib/api';
import { useLive } from '../../../../../lib/live/use-live';
import {
  describeSchedulesError,
  isNotFound,
} from '../../../../../lib/schedules/format';
import { useSection } from '../../../../../lib/section/use-section';
import { useProjectDetail } from '../use-project-detail';
import { type ProfileChoice, ScheduleDialog } from './schedule-dialog';
import { ScheduleSheet } from './schedule-sheet';
import { ScheduleTable } from './schedule-table';

/** A live push is a hint to re-read; bursts are collapsed into one fetch. */
const REFETCH_DEBOUNCE_MS = 500;

function DeleteDialog({
  schedule,
  busy,
  onCancel,
  onConfirm,
}: {
  schedule: ScheduleView | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      open={schedule !== null}
      onOpenChange={(open) => !open && !busy && onCancel()}
      title={schedule ? `Delete ${schedule.name}?` : 'Delete this schedule?'}
      consequence="The schedule and its firings are removed; runs it already started stay in history. This cannot be undone."
      verb="Delete"
      tone="danger"
      busy={busy}
      onConfirm={onConfirm}
    />
  );
}

export default function ProjectSchedulesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const project = useProjectDetail(projectId).data;
  const [skills, setSkills] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<ProfileChoice[]>([]);
  /** Bumped by a live push; the open sheet refetches on it. */
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState<ScheduleView | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ScheduleView | null>(null);
  const [selected, setSelected] = useState<string>();
  const [busyId, setBusyId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const schedules = useSection(
    () => api<ScheduleView[]>(`/projects/${projectId}/schedules`),
    [projectId],
  );
  const load = schedules.retry;

  useLive(`project:${projectId}`, (message) => {
    if (
      message.event !== SCHEDULE_UPDATED_LIVE_EVENT &&
      message.event !== SCHEDULE_FIRING_UPDATED_LIVE_EVENT
    ) {
      return;
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void load();
      setVersion((v) => v + 1);
    }, REFETCH_DEBOUNCE_MS);
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  const canOperate = project !== undefined && project.role !== 'viewer';
  const isAdmin = project?.role === 'admin';
  const runnerId = project?.runnerId;

  // Skill suggestions for the dialog; a failure only costs the suggestions.
  useEffect(() => {
    if (!canOperate) return;
    api<InstalledSkillsView>(`/projects/${projectId}/skills`)
      .then((view) =>
        setSkills(
          [
            ...new Set(
              view.items
                .filter((s) => s.runnable && s.runtime === 'claude')
                .map((s) => s.invocation),
            ),
          ].sort(),
        ),
      )
      .catch(() => setSkills([]));
  }, [canOperate, projectId]);

  // Only an admin can read the runner's profiles; others use the project default.
  useEffect(() => {
    if (!isAdmin || !runnerId) return;
    api<AdminRunnerDetail>(`/admin/runners/${runnerId}`)
      .then((runner) =>
        setProfiles(
          runner.profiles
            .filter((p) => !p.missing && p.runtime === 'claude')
            .map((p) => ({ id: p.id, label: p.label || p.key })),
        ),
      )
      .catch(() => setProfiles([]));
  }, [isAdmin, runnerId]);

  const act = useCallback(
    async (
      schedule: ScheduleView,
      run: () => Promise<unknown>,
      done: string,
    ) => {
      setBusyId(schedule.id);
      try {
        await run();
        toast.success(done);
        load();
        setVersion((v) => v + 1);
      } catch (err) {
        toast.error(describeSchedulesError(err));
        load();
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const actions = useMemo(
    () =>
      canOperate
        ? {
            onToggle: (schedule: ScheduleView, enabled: boolean) =>
              void act(
                schedule,
                () =>
                  api(`/projects/${projectId}/schedules/${schedule.id}`, {
                    method: 'PATCH',
                    body: { enabled },
                  }),
                enabled ? 'Schedule enabled.' : 'Schedule disabled.',
              ),
            onEdit: setEditing,
            onRunNow: (schedule: ScheduleView) =>
              void act(
                schedule,
                () =>
                  api(
                    `/projects/${projectId}/schedules/${schedule.id}/run-now`,
                    { method: 'POST' },
                  ),
                'Fired once. It shows in the firings.',
              ),
            onDelete: setDeleting,
          }
        : undefined,
    [canOperate, act, projectId],
  );

  const confirmDelete = async () => {
    const target = deleting;
    if (!target) return;
    await act(
      target,
      () =>
        api(`/projects/${projectId}/schedules/${target.id}`, {
          method: 'DELETE',
        }),
      'Schedule deleted.',
    );
    setDeleting(null);
    setSelected((current) => (current === target.id ? undefined : current));
  };

  if (schedules.data === undefined && isNotFound(schedules.error)) {
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
          title="Schedules"
          description="Skills and orchestrator commands that run on this project at fixed times, with their creator’s authority."
          actions={
            canOperate ? (
              <Button variant="solid" onClick={() => setCreating(true)}>
                New schedule
              </Button>
            ) : undefined
          }
        />
        {project ? <RunnerOfflineBanner project={project} /> : null}
      </div>

      <AsyncSection
        section={schedules}
        unavailable={{
          title: 'Schedules could not be loaded',
          stillWorks:
            'Nothing was changed. Fleet and queue are still available.',
        }}
        empty={
          <EmptyState
            title="No schedules yet"
            description={
              canOperate
                ? 'A schedule runs a skill, or starts the orchestrator, at fixed times, for example a skill every night or a new round every morning.'
                : 'An operator of this project can create one.'
            }
            action={
              canOperate ? (
                <Button variant="glass" onClick={() => setCreating(true)}>
                  New schedule
                </Button>
              ) : undefined
            }
          />
        }
      >
        {(list) => (
          <ScheduleTable
            schedules={list}
            actions={actions}
            busyId={busyId}
            onOpen={(schedule) => setSelected(schedule.id)}
          />
        )}
      </AsyncSection>

      <ScheduleDialog
        projectId={projectId}
        open={creating || editing !== null}
        schedule={editing}
        skills={skills}
        profiles={profiles}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={() => {
          setCreating(false);
          setEditing(null);
          toast.success('Schedule saved.');
          void load();
          setVersion((v) => v + 1);
        }}
      />
      <DeleteDialog
        schedule={deleting}
        busy={busyId !== null && busyId === deleting?.id}
        onCancel={() => setDeleting(null)}
        onConfirm={confirmDelete}
      />
      <ScheduleSheet
        projectId={projectId}
        scheduleId={selected}
        version={version}
        onClose={() => setSelected(undefined)}
      />
    </div>
  );
}
