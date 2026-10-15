'use client';

import type { RunPage, RunSummary } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { buttonClassName } from '@andrewbehma/glass-ui/button';
import { type Column, DataTable } from '@andrewbehma/glass-ui/data-table';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { ChevronRight } from 'lucide-react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { AsyncSection } from '../../../../../components/prerequisites/async-section';
import { ScrollX } from '../../../../../components/scroll-x/scroll-x';
import { Time } from '../../../../../lib/format/time';
import {
  costLabel,
  prLabel,
  RUN_KIND_LABEL,
  RUN_STATUS_LABEL,
  runTitle,
} from '../../../../../lib/history/format';
import { slotHue } from '../../../../../lib/hue';
import { isTask } from '../../../../../lib/project-home/analytics';
import type { Section } from '../../../../../lib/section/use-section';
import { formatDuration } from '../../../../../lib/sessions/format';
import { RUN_PILL_STATUS } from '../../../../../lib/status/pill';

/** How many rows the page shows; History has the rest. */
export const RECENT_TASKS = 6;

/** The latest work the project's agents picked up, each row opening its run. */
export function RecentTasks({
  projectId,
  runs,
}: {
  projectId: string;
  runs: Section<RunPage>;
}) {
  const router = useRouter();
  const history = `/projects/${projectId}/history`;
  const columns = useMemo<Column<RunSummary>[]>(
    () => [
      {
        id: 'task',
        header: 'Task',
        cell: (run) => (
          <span className="flex min-w-48 flex-col">
            <NextLink
              href={`${history}/${run.id}`}
              className="underline-offset-2 hover:underline"
            >
              {runTitle(run)}
            </NextLink>
            <span className="text-xs text-ink-3">
              {RUN_KIND_LABEL[run.kind]}
            </span>
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        cell: (run) => (
          <StatusPill
            size="md"
            status={RUN_PILL_STATUS[run.status]}
            label={RUN_STATUS_LABEL[run.status]}
          />
        ),
      },
      {
        id: 'slot',
        header: 'Slot',
        cell: (run) =>
          run.slot ? (
            <span className="inline-flex items-center gap-2 whitespace-nowrap">
              <Badge dot hue={slotHue(run.slot)} aria-hidden="true" />
              {run.slot}
            </span>
          ) : (
            <span className="text-ink-3">—</span>
          ),
      },
      {
        id: 'pr',
        header: 'Pull request',
        cell: (run) => (
          <span className="whitespace-nowrap">{prLabel(run)}</span>
        ),
      },
      {
        id: 'duration',
        header: 'Duration',
        align: 'end',
        cell: (run) => (
          <span className="num whitespace-nowrap">
            {formatDuration(run.durationMs) || '—'}
          </span>
        ),
      },
      {
        id: 'cost',
        header: 'Cost',
        align: 'end',
        cell: (run) => (
          <span className="num whitespace-nowrap">{costLabel(run.usage)}</span>
        ),
      },
      {
        id: 'updated',
        header: 'Updated',
        align: 'end',
        cell: (run) => (
          <span className="whitespace-nowrap text-ink-2">
            <Time value={run.updatedAt} />
          </span>
        ),
      },
    ],
    [history],
  );

  return (
    <section aria-labelledby="project-recent" className="flex flex-col gap-3">
      <SectionHeader
        title="Recent tasks"
        headingId="project-recent"
        description="The latest work the agents picked up, newest first."
        actions={
          <NextLink
            href={history}
            className={buttonClassName({ variant: 'ghost', size: 'sm' })}
          >
            Open history
            <ChevronRight aria-hidden="true" className="size-4" />
          </NextLink>
        }
      />
      <AsyncSection
        section={runs}
        unavailable={{
          title: 'Recent tasks could not be loaded',
          stillWorks: 'History and the fleet are still available.',
        }}
        isEmpty={(page) => !page.items.some(isTask)}
        empty={
          <EmptyState
            title="No tasks yet"
            description="A task appears here once the orchestrator, a board card or a skill starts work."
            link={NextLink}
            action={{
              label: 'Open Fleet',
              href: `/projects/${projectId}/fleet`,
            }}
          />
        }
        skeleton={
          <DataTable
            rows={[]}
            getRowId={(run: RunSummary) => run.id}
            columns={columns}
            loading
          />
        }
      >
        {(page) => (
          <ScrollX label="Recent tasks">
            <DataTable
              rows={page.items.filter(isTask).slice(0, RECENT_TASKS)}
              getRowId={(run) => run.id}
              columns={columns}
              onRowActivate={(run) => router.push(`${history}/${run.id}`)}
            />
          </ScrollX>
        )}
      </AsyncSection>
    </section>
  );
}
