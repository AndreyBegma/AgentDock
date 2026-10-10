'use client';

import type { AdminScheduleView, ScheduleView } from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Button } from 'glass-ui/button';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { Toggle } from 'glass-ui/toggle';
import Link from 'next/link';
import {
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
  return (
    <Table scroll>
      <TableHead>
        <TableRow>
          <TableCell head>Name</TableCell>
          {showProject ? <TableCell head>Project</TableCell> : null}
          <TableCell head>Runs</TableCell>
          <TableCell head>Cron</TableCell>
          <TableCell head>Next run</TableCell>
          <TableCell head>Last firing</TableCell>
          <TableCell head>Enabled</TableCell>
          {actions ? (
            <TableCell head>
              <span className="sr-only">Actions</span>
            </TableCell>
          ) : null}
        </TableRow>
      </TableHead>
      <tbody>
        {schedules.map((schedule) => {
          const last = schedule.lastFiring;
          const busy = busyId === schedule.id;
          return (
            <TableRow key={schedule.id}>
              <TableCell>
                <button
                  type="button"
                  className="text-left font-medium underline-offset-2 hover:underline"
                  onClick={() => onOpen(schedule)}
                >
                  {schedule.name}
                </button>
                {schedule.disabledReason && !schedule.enabled ? (
                  <div className="text-xs text-warn">
                    disabled: {schedule.disabledReason.replaceAll('_', ' ')}
                  </div>
                ) : null}
              </TableCell>
              {showProject ? (
                <TableCell>
                  <Link
                    href={`/projects/${schedule.projectId}/schedules`}
                    className="underline-offset-2 hover:underline"
                  >
                    {'projectName' in schedule
                      ? schedule.projectName
                      : schedule.projectId}
                  </Link>
                </TableCell>
              ) : null}
              <TableCell>
                <span className="font-mono text-sm">
                  {describeTarget(schedule.target)}
                </span>
              </TableCell>
              <TableCell>
                <span className="font-mono text-sm">{schedule.cron}</span>
                <div className="text-xs text-ink-3">{schedule.timezone}</div>
              </TableCell>
              <TableCell>{nextRunLabel(schedule)}</TableCell>
              <TableCell>
                {last ? (
                  <Badge
                    tone={FIRING_STATUS_TONE[last.status]}
                    label={FIRING_STATUS_LABEL[last.status]}
                  />
                ) : (
                  <span className="text-ink-3">never</span>
                )}
              </TableCell>
              <TableCell>
                {actions ? (
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
                )}
              </TableCell>
              {actions ? (
                <TableCell>
                  <div className="flex justify-end gap-2">
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
                  </div>
                </TableCell>
              ) : null}
            </TableRow>
          );
        })}
      </tbody>
    </Table>
  );
}
