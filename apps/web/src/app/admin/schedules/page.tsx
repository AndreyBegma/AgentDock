'use client';

import type {
  AdminScheduleView,
  ScheduleView,
  SystemJobView,
} from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { EmptyState } from 'glass-ui/empty-state';
import { Field, Select } from 'glass-ui/field';
import { Skeleton } from 'glass-ui/skeleton';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { toast } from 'glass-ui/toast';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { formatAgo } from '../../../lib/fleet/format';
import {
  describeSchedulesError,
  formatFireTime,
} from '../../../lib/schedules/format';
import { ScheduleSheet } from '../../(app)/projects/[projectId]/schedules/schedule-sheet';
import { ScheduleTable } from '../../(app)/projects/[projectId]/schedules/schedule-table';

/** The page polls; the project page is the one that listens to live events. */
const POLL_MS = 15_000;

type EnabledFilter = 'all' | 'on' | 'off';

const enabledQuery = (filter: EnabledFilter): string =>
  filter === 'all' ? '' : `?enabled=${filter === 'on'}`;

function SystemJobs() {
  const [jobs, setJobs] = useState<SystemJobView[]>();

  useEffect(() => {
    const load = () =>
      api<SystemJobView[]>('/admin/system-jobs')
        .then(setJobs)
        .catch((err) => toast.error(describeSchedulesError(err)));
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <section aria-labelledby="system-jobs">
      <h2 id="system-jobs" className="mb-1 text-sm font-semibold">
        System jobs
      </h2>
      <p className="mb-2 text-sm text-ink-2">
        The API’s own recurring jobs. Read-only: they are not schedules.
      </p>
      {!jobs ? (
        <Skeleton className="h-24 w-full" />
      ) : jobs.length === 0 ? (
        <EmptyState
          title="No system jobs registered"
          description="Jobs appear here once their modules register with the scheduler."
        />
      ) : (
        <Table scroll>
          <TableHead>
            <TableRow>
              <TableCell head>Job</TableCell>
              <TableCell head>Type</TableCell>
              <TableCell head>Cron</TableCell>
              <TableCell head>Next run</TableCell>
              <TableCell head>Last run</TableCell>
            </TableRow>
          </TableHead>
          <tbody>
            {jobs.map((job) => (
              <TableRow key={job.name}>
                <TableCell>
                  <span className="font-mono text-sm">{job.name}</span>
                </TableCell>
                <TableCell>
                  <Badge tone="neutral" label={job.kind} />
                </TableCell>
                <TableCell>
                  {job.cron ? (
                    <span className="font-mono text-sm">{job.cron}</span>
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell>
                  {formatFireTime(job.nextRunAt, 'UTC', true)}
                </TableCell>
                <TableCell>
                  {job.lastRunAt ? formatAgo(job.lastRunAt) : '—'}
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}

export default function AdminSchedulesPage() {
  const [schedules, setSchedules] = useState<AdminScheduleView[]>();
  const [filter, setFilter] = useState<EnabledFilter>('all');
  const [selected, setSelected] = useState<ScheduleView>();

  const load = useCallback(async () => {
    try {
      setSchedules(
        await api<AdminScheduleView[]>(
          `/admin/schedules${enabledQuery(filter)}`,
        ),
      );
    } catch (err) {
      toast.error(describeSchedulesError(err));
    }
  }, [filter]);

  useEffect(() => {
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Schedules</h1>
          <p className="text-sm text-ink-2">
            Every project’s schedules. Create and edit them on the project’s own
            page.
          </p>
        </div>
        <Field label="Show" htmlFor="schedules-filter">
          <Select
            id="schedules-filter"
            value={filter}
            onChange={(e) =>
              setFilter(
                e.target.value === 'on'
                  ? 'on'
                  : e.target.value === 'off'
                    ? 'off'
                    : 'all',
              )
            }
          >
            <option value="all">All</option>
            <option value="on">Enabled</option>
            <option value="off">Disabled</option>
          </Select>
        </Field>
      </div>

      {!schedules ? (
        <Skeleton className="h-48 w-full" />
      ) : schedules.length === 0 ? (
        <EmptyState
          title="No schedules"
          description={
            filter === 'all'
              ? 'No project has a schedule yet.'
              : 'No schedule matches this filter.'
          }
        />
      ) : (
        <ScheduleTable schedules={schedules} showProject onOpen={setSelected} />
      )}

      <SystemJobs />

      <ScheduleSheet
        projectId={selected?.projectId ?? ''}
        scheduleId={selected?.id}
        version={0}
        onClose={() => setSelected(undefined)}
      />
    </div>
  );
}
