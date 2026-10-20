'use client';

import type { AdminScheduleView, ScheduleView } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { type Column } from '@andrewbehma/glass-ui/data-table';
import {
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuTrigger,
} from '@andrewbehma/glass-ui/menu';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import { MoreHorizontal } from 'lucide-react';
import Link from 'next/link';
import { ResponsiveRows } from '../../../../../components/responsive-rows/responsive-rows';
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

type Row = ScheduleView | AdminScheduleView;

/** Edit, Run now and Delete behind one menu: three buttons a row was noise. */
function RowMenu({
  schedule,
  actions,
  busy,
}: {
  schedule: Row;
  actions: ScheduleActions;
  busy: boolean;
}) {
  return (
    <MenuRoot>
      <MenuTrigger asChild>
        <Button
          variant="ghost"
          icon
          size="sm"
          disabled={busy}
          aria-label={`Actions for ${schedule.name}`}
        >
          <MoreHorizontal aria-hidden="true" className="size-4" />
        </Button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuItem onSelect={() => actions.onEdit(schedule)}>Edit</MenuItem>
        <MenuItem onSelect={() => actions.onRunNow(schedule)}>Run now</MenuItem>
        <MenuItem tone="danger" onSelect={() => actions.onDelete(schedule)}>
          Delete
        </MenuItem>
      </MenuContent>
    </MenuRoot>
  );
}

function EnabledControl({
  schedule,
  actions,
}: {
  schedule: Row;
  actions?: ScheduleActions;
}) {
  return actions ? (
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
  );
}

function LastFiring({ schedule }: { schedule: Row }) {
  const last = schedule.lastFiring;
  return last ? (
    <Badge
      tone={FIRING_STATUS_TONE[last.status]}
      label={FIRING_STATUS_LABEL[last.status]}
    />
  ) : (
    <span className="text-ink-3">never</span>
  );
}

/**
 * The schedules of a project and, with `showProject`, of the admin page: a
 * table from tablet up, stacked rows on a phone (stack S-7). Clicking a name
 * opens the detail sheet; Edit, Run now and Delete sit in the row's menu.
 */
export function ScheduleTable({
  schedules,
  showProject = false,
  actions,
  busyId,
  onOpen,
}: {
  schedules: Row[];
  showProject?: boolean;
  actions?: ScheduleActions;
  busyId?: string | null;
  onOpen: (schedule: ScheduleView) => void;
}) {
  const nameButton = (schedule: Row) => (
    <button
      type="button"
      className="min-w-0 text-left font-medium underline-offset-2 hover:underline"
      onClick={() => onOpen(schedule)}
    >
      {schedule.name}
    </button>
  );
  const projectLink = (schedule: Row) => (
    <Link
      href={`/projects/${schedule.projectId}/schedules`}
      className="underline-offset-2 hover:underline"
    >
      {'projectName' in schedule ? schedule.projectName : schedule.projectId}
    </Link>
  );
  const columns: Column<Row>[] = [
    {
      id: 'name',
      header: 'Schedule',
      cell: (schedule) => (
        <span className="flex flex-col">
          {nameButton(schedule)}
          <span className="font-mono text-xs text-ink-3">
            {describeTarget(schedule.target)}
          </span>
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
            cell: projectLink,
          },
        ]
      : []),
    {
      id: 'cron',
      header: 'When',
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
      cell: (schedule) => <LastFiring schedule={schedule} />,
    },
    {
      id: 'enabled',
      header: 'On',
      cell: (schedule) => (
        <EnabledControl schedule={schedule} actions={actions} />
      ),
    },
    ...(actions
      ? [
          {
            id: 'actions',
            header: <span className="sr-only">Actions</span>,
            align: 'end' as const,
            cell: (schedule: Row) => (
              <RowMenu
                schedule={schedule}
                actions={actions}
                busy={busyId === schedule.id}
              />
            ),
          },
        ]
      : []),
  ];
  return (
    <ResponsiveRows
      label="Schedules"
      rows={schedules}
      getRowId={(schedule) => schedule.id}
      columns={columns}
      stacked={(schedule) => (
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-start justify-between gap-3">
            <span className="flex min-w-0 flex-col">
              {nameButton(schedule)}
              {showProject ? (
                <span className="text-xs text-ink-3">
                  {projectLink(schedule)}
                </span>
              ) : null}
              <span className="break-all font-mono text-xs text-ink-3">
                {describeTarget(schedule.target)}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <EnabledControl schedule={schedule} actions={actions} />
              {actions ? (
                <RowMenu
                  schedule={schedule}
                  actions={actions}
                  busy={busyId === schedule.id}
                />
              ) : null}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2">
            <span className="font-mono">{schedule.cron}</span>
            <span>{nextRunLabel(schedule)}</span>
            <LastFiring schedule={schedule} />
          </div>
          {schedule.disabledReason && !schedule.enabled ? (
            <span className="text-xs text-warn">
              {DISABLED_REASON_LABEL[schedule.disabledReason]}
            </span>
          ) : null}
        </div>
      )}
    />
  );
}
