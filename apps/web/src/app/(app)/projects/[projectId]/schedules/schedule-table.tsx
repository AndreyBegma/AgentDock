'use client';

import type { AdminScheduleView, ScheduleView } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { type Column, DataTable } from '@andrewbehma/glass-ui/data-table';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import Link from 'next/link';
import { ScrollX } from '../../../../../components/scroll-x/scroll-x';
import {
  DISABLED_REASON_LABEL,
  describeTarget,
  FIRING_STATUS_LABEL,
  FIRING_STATUS_TONE,
  nextRunLabel,
} from '../../../../../lib/schedules/format';

/** Actions a viewer does not get; omit them all for a read-only table. */
export interface ScheduleActions {
  onToggle: (schedule: ScheduleView, enabled: boolean) => void;
  onEdit: (schedule: ScheduleView) => void;
  onRunNow: (schedule: ScheduleView) => void;
  onDelete: (schedule: ScheduleView) => void;
}

/**
 * The schedules table of a project and, with `showProject`, of the admin page.
 * Clicking a name opens the detail sheet.
 */
export function ScheduleTable({
  schedules,
  showProject = false,
  actions,
  busyId,
  onOpen,
}: {
  schedules: Array<ScheduleView | AdminScheduleView>;
  showProject?: boolean;
  actions?: ScheduleActions;
  busyId?: string | null;
  onOpen: (schedule: ScheduleView) => void;
}) {
  type Row = ScheduleView | AdminScheduleView;
  const columns: Column<Row>[] = [
    {
      id: 'name',
      header: 'Name',
      cell: (schedule) => (
        <span className="flex flex-col">
          <button
            type="button"
            className="text-left font-medium underline-offset-2 hover:underline"
            onClick={() => onOpen(schedule)}
          >
            {schedule.name}
          </button>
          {schedule.disabledReason && !schedule.enabled ? (
            <span className="text-xs text-warn">
              {DISABLED_REASON_LABEL[schedule.disabledReason]}
            </span>
          ) : null}
        </span>
      ),
    },
    ...(showProject
      ? [
          {
            id: 'project',
            header: 'Project',
            cell: (schedule: Row) => (
              <Link
                href={`/projects/${schedule.projectId}/schedules`}
                className="underline-offset-2 hover:underline"
              >
                {'projectName' in schedule
                  ? schedule.projectName
                  : schedule.projectId}
              </Link>
            ),
          },
        ]
      : []),
    {
      id: 'runs',
      header: 'Runs',
      cell: (schedule) => (
        <span className="font-mono text-sm">
          {describeTarget(schedule.target)}
        </span>
      ),
    },
    {
      id: 'cron',
      header: 'Cron',
      cell: (schedule) => (
        <span className="flex flex-col">
          <span className="font-mono text-sm">{schedule.cron}</span>
          <span className="text-xs text-ink-3">{schedule.timezone}</span>
        </span>
      ),
    },
    { id: 'next', header: 'Next run', cell: (s) => nextRunLabel(s) },
    {
      id: 'last',
      header: 'Last firing',
      cell: ({ lastFiring: last }) =>
        last ? (
          <Badge
            tone={FIRING_STATUS_TONE[last.status]}
            label={FIRING_STATUS_LABEL[last.status]}
          />
        ) : (
          <span className="text-ink-3">never</span>
        ),
    },
    {
      id: 'enabled',
      header: 'Enabled',
      cell: (schedule) =>
        actions ? (
          <>
            <span id={`schedule-on-${schedule.id}`} className="sr-only">
              Enable {schedule.name}
            </span>
            <Toggle
              checked={schedule.enabled}
              labelledBy={`schedule-on-${schedule.id}`}
              onChange={(value) => actions.onToggle(schedule, value)}
            />
          </>
        ) : (
          <Badge
            tone={schedule.enabled ? 'ok' : 'neutral'}
            label={schedule.enabled ? 'on' : 'off'}
          />
        ),
    },
    ...(actions
      ? [
          {
            id: 'actions',
            header: <span className="sr-only">Actions</span>,
            align: 'end' as const,
            cell: (schedule: Row) => {
              const busy = busyId === schedule.id;
              return (
                <span className="inline-flex justify-end gap-2">
                  <Button
                    variant="glass"
                    size="sm"
                    disabled={busy}
                    onClick={() => actions.onEdit(schedule)}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="glass"
                    size="sm"
                    disabled={busy}
                    onClick={() => actions.onRunNow(schedule)}
                  >
                    Run now
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => actions.onDelete(schedule)}
                  >
                    Delete
                  </Button>
                </span>
              );
            },
          },
        ]
      : []),
  ];
  return (
    <ScrollX label="Schedules" edgeClassName="from-surface">
      <DataTable
        rows={schedules}
        getRowId={(schedule) => schedule.id}
        columns={columns}
        stickyHeader={false}
      />
    </ScrollX>
  );
}
