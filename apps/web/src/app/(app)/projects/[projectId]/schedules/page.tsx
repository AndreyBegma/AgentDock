'use client';

import type {
  AdminRunnerDetail,
  InstalledSkillsView,
  ProjectDetail,
  ScheduleView,
} from '@agentdock/shared';
import {
  SCHEDULE_FIRING_UPDATED_LIVE_EVENT,
  SCHEDULE_UPDATED_LIVE_EVENT,
} from '@agentdock/shared';
import { Button } from 'glass-ui/button';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { EmptyState } from 'glass-ui/empty-state';
import { Skeleton } from 'glass-ui/skeleton';
import { toast } from 'glass-ui/toast';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../../../../lib/api';
import { useLive } from '../../../../../lib/live/use-live';
import {
  describeSchedulesError,
  isNotFound,
} from '../../../../../lib/schedules/format';
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
    <DialogRoot
      open={schedule !== null}
      onOpenChange={(open) => !open && !busy && onCancel()}
    >
      <DialogContent
        title={schedule ? `Delete ${schedule.name}?` : 'Delete schedule'}
        description="The schedule and its firings are removed. Runs it already started stay in history."
        footer={
          <>
            <Button variant="glass" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={onConfirm}>
              {busy ? 'Deleting…' : 'Delete'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">This cannot be undone.</p>
      </DialogContent>
    </DialogRoot>
  );
}

export default function ProjectSchedulesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<ProjectDetail>();
  const [schedules, setSchedules] = useState<ScheduleView[]>();
  const [skills, setSkills] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<ProfileChoice[]>([]);
  const [missing, setMissing] = useState(false);
  /** Bumped by a live push; the open sheet refetches on it. */
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState<ScheduleView | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ScheduleView | null>(null);
  const [selected, setSelected] = useState<string>();
  const [busyId, setBusyId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const [detail, list] = await Promise.all([
        api<ProjectDetail>(`/projects/${projectId}`),
        api<ScheduleView[]>(`/projects/${projectId}/schedules`),
      ]);
      setProject(detail);
      setSchedules(list);
      setMissing(false);
    } catch (err) {
      if (isNotFound(err)) setMissing(true);
      else toast.error(describeSchedulesError(err));
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

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
        await load();
        setVersion((v) => v + 1);
      } catch (err) {
        toast.error(describeSchedulesError(err));
        await load();
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

  if (missing) {
    return (
      <EmptyState
        title="Project not found"
        description="It was removed, or you are not a member of it."
      />
    );
  }
  if (!project || !schedules) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Schedules</h1>
          <p className="text-sm text-ink-2">
            Skills and orchestrator commands that run on this project at fixed
            times, with their creator’s authority.
          </p>
        </div>
        {canOperate ? (
          <Button onClick={() => setCreating(true)}>New schedule</Button>
        ) : null}
      </div>

      {schedules.length === 0 ? (
        <EmptyState
          title="No schedules yet"
          description={
            canOperate
              ? 'Create one to run a skill every night, or the orchestrator every hour.'
              : 'An operator of this project can create one.'
          }
        />
      ) : (
        <ScheduleTable
          schedules={schedules}
          actions={actions}
          busyId={busyId}
          onOpen={(schedule) => setSelected(schedule.id)}
        />
      )}

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
