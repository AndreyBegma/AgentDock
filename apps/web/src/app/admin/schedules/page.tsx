'use client';

import type {
  AdminScheduleView,
  ScheduleView,
  SystemJobView,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Select } from '@andrewbehma/glass-ui/field';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import { Toolbar } from '@andrewbehma/glass-ui/toolbar';
import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { PageHeader } from '../../../components/page-header/page-header';
import { AsyncSection } from '../../../components/prerequisites/async-section';
import { api } from '../../../lib/api';
import {
  type ChipDef,
  type FilterCodec,
} from '../../../lib/filters/url-filters';
import {
  useFilterChips,
  useUrlFilters,
} from '../../../lib/filters/use-url-filters';
import { Time } from '../../../lib/format/time';
import { formatFireTime } from '../../../lib/schedules/format';
import { useSection } from '../../../lib/section/use-section';
import { ScheduleSheet } from '../../(app)/projects/[projectId]/schedules/schedule-sheet';
import { ScheduleTable } from '../../(app)/projects/[projectId]/schedules/schedule-table';

/** The page polls; the project page is the one that listens to live events. */
const POLL_MS = 15_000;

type EnabledFilter = 'all' | 'on' | 'off';

interface ScheduleFilters {
  enabled: EnabledFilter;
}

/** `?enabled=on|off`; "all" is the plain URL. */
const FILTER_CODEC: FilterCodec<ScheduleFilters> = {
  keys: ['enabled'],
  parse: (params) => {
    const value = params.get('enabled');
    return { enabled: value === 'on' || value === 'off' ? value : 'all' };
  },
  search: ({ enabled }) => (enabled === 'all' ? '' : `?enabled=${enabled}`),
};

const CHIP_DEFS: ChipDef<ScheduleFilters>[] = [
  {
    key: 'enabled',
    label: ({ enabled }) =>
      enabled === 'all'
        ? null
        : `Show: ${enabled === 'on' ? 'Enabled' : 'Disabled'}`,
    clear: { enabled: 'all' },
  },
];

const enabledQuery = (filter: EnabledFilter): string =>
  filter === 'all' ? '' : `?enabled=${filter === 'on'}`;

const projectsLinkClass = buttonClassName({ variant: 'glass', size: 'sm' });

const JOB_KIND_LABEL: Record<SystemJobView['kind'], string> = {
  cron: 'On a timetable',
  interval: 'At a fixed interval',
};

function SystemJobs() {
  const jobs = useSection(() => api<SystemJobView[]>('/admin/system-jobs'), []);
  const reload = jobs.retry;

  useEffect(() => {
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  return (
    <section aria-labelledby="system-jobs">
      <SectionHeader
        className="mb-2"
        headingId="system-jobs"
        title="System jobs"
        description="The API’s own recurring jobs, such as clean-ups. Read-only: they are not schedules. Times are in UTC."
      />
      <AsyncSection
        section={jobs}
        unavailable={{
          title: 'System jobs are not answering',
          stillWorks: 'The jobs keep running on the server.',
        }}
        skeleton={<Skeleton className="h-24 w-full" />}
        empty={
          <EmptyState
            title="The API’s own recurring jobs"
            description="None has registered yet. Jobs appear here once the API starts them; a restart of the API registers them again."
          />
        }
      >
        {(list) => (
          <Table scroll>
            <TableHead>
              <TableRow>
                <TableCell head>Job</TableCell>
                <TableCell head>Type</TableCell>
                <TableCell head>Cron</TableCell>
                <TableCell head>Next run (UTC)</TableCell>
                <TableCell head>Last run</TableCell>
              </TableRow>
            </TableHead>
            <tbody>
              {list.map((job) => (
                <TableRow key={job.name}>
                  <TableCell>
                    <span className="font-mono text-sm">{job.name}</span>
                  </TableCell>
                  <TableCell>
                    <Badge tone="neutral" label={JOB_KIND_LABEL[job.kind]} />
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
                    <Time value={job.lastRunAt} />
                  </TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
        )}
      </AsyncSection>
    </section>
  );
}

function AdminSchedules() {
  const url = useUrlFilters(FILTER_CODEC);
  const filter = url.filters.enabled;
  const chips = useFilterChips(url, CHIP_DEFS);
  const schedules = useSection(
    () => api<AdminScheduleView[]>(`/admin/schedules${enabledQuery(filter)}`),
    [filter],
  );
  const [selected, setSelected] = useState<ScheduleView>();
  const reload = schedules.retry;

  useEffect(() => {
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        className="mb-0"
        title="Schedules"
        description={
          <>
            Every project’s schedules. Create and edit them on the project’s own
            Schedules page, under{' '}
            <Link
              href="/projects"
              className="text-accent-ink underline underline-offset-2"
            >
              Projects
            </Link>
            . Each schedule’s times are in the timezone shown under it.
          </>
        }
      />

      <Toolbar
        aria-label="Filter schedules"
        collapseBelow="sm"
        activeFilters={chips.activeFilters}
        onClearAll={chips.onClearAll}
        filters={
          <Select
            aria-label="Show"
            value={filter}
            className="w-full sm:w-44"
            onChange={(e) =>
              url.set({
                enabled:
                  e.target.value === 'on'
                    ? 'on'
                    : e.target.value === 'off'
                      ? 'off'
                      : 'all',
              })
            }
          >
            <option value="all">All schedules</option>
            <option value="on">Enabled</option>
            <option value="off">Disabled</option>
          </Select>
        }
      />

      <AsyncSection
        section={schedules}
        unavailable={{
          title: 'Schedules are not answering',
          stillWorks: 'Schedules keep firing on the server.',
        }}
        skeleton={<Skeleton className="h-48 w-full" />}
        empty={
          filter === 'all' ? (
            <EmptyState
              title="Work that starts on a timetable"
              description="No project has a schedule yet. Open a project and create one on its Schedules page."
              action={
                <Link href="/projects" className={projectsLinkClass}>
                  Open Projects
                </Link>
              }
            />
          ) : (
            <EmptyState
              title={`No ${filter === 'on' ? 'enabled' : 'disabled'} schedules`}
              description="Other schedules are hidden by the Show filter."
              action={
                <Button
                  variant="glass"
                  onClick={() => url.set({ enabled: 'all' })}
                >
                  Show all
                </Button>
              }
            />
          )
        }
      >
        {(list) => (
          <ScheduleTable schedules={list} showProject onOpen={setSelected} />
        )}
      </AsyncSection>

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

export default function AdminSchedulesPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <AdminSchedules />
    </Suspense>
  );
}
