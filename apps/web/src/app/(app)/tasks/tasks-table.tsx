'use client';

import type { TaskRow } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { DataTable } from '@andrewbehma/glass-ui/data-table';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { Bug, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { ScrollX } from '../../../components/scroll-x/scroll-x';
import { Time } from '../../../lib/format/time';
import { projectHue } from '../../../lib/hue';
import { safeHttpsUrl } from '../../../lib/queue/format';
import {
  rowStatus,
  TASK_KIND_LABEL,
  TASK_PILL_STATUS,
  TASK_STATUS_LABEL,
  taskPlannerHref,
} from '../../../lib/tasks/format';

/** A link that leaves the row's own action alone: the row opens the task. */
function ExternalLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="font-medium underline-offset-2 hover:underline"
      onClick={(event) => event.stopPropagation()}
    >
      {label}
    </a>
  );
}

function useColumns() {
  return useMemo(
    () => [
      {
        id: 'project',
        header: 'Project',
        width: '7.5rem',
        cell: (r: TaskRow) => (
          <Badge
            hue={projectHue(r.projectId)}
            label={r.projectName}
            className="max-w-full truncate"
          />
        ),
      },
      {
        id: 'plan',
        header: 'Plan',
        width: '9rem',
        cell: (r: TaskRow) => (
          <span className="block max-w-32 truncate" title={r.planTitle}>
            {r.planTitle}
          </span>
        ),
      },
      {
        id: 'task',
        header: 'Task',
        cell: (r: TaskRow) => (
          <span className="block max-w-72 min-w-44 whitespace-normal">
            <code className="me-2 text-xs text-ink-3">{r.key}</code>
            <Link
              href={taskPlannerHref(r)}
              className="font-medium underline-offset-2 hover:underline"
              // The row opens the task too; one activation, not two.
              onClick={(event) => event.stopPropagation()}
              tabIndex={-1}
            >
              {r.title}
            </Link>
          </span>
        ),
      },
      {
        id: 'kind',
        header: 'Kind',
        width: '6.5rem',
        cell: (r: TaskRow) => (
          <span className="inline-flex items-center gap-1.5">
            {r.kind === 'bug' ? (
              <Bug aria-hidden="true" className="size-3.5" />
            ) : (
              <Sparkles aria-hidden="true" className="size-3.5" />
            )}
            {TASK_KIND_LABEL[r.kind]}
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        width: '9.5rem',
        cell: (r: TaskRow) => {
          const status = rowStatus(r);
          return (
            <StatusPill
              status={TASK_PILL_STATUS[status]}
              label={TASK_STATUS_LABEL[status]}
            />
          );
        },
      },
      {
        id: 'issue',
        header: 'Issue',
        width: '4.5rem',
        cell: (r: TaskRow) => {
          const url = r.issue ? safeHttpsUrl(r.issue.url) : null;
          if (!r.issue) return <span className="text-ink-3">—</span>;
          return url ? (
            <ExternalLink href={url} label={`#${r.issue.number}`} />
          ) : (
            <span>#{r.issue.number}</span>
          );
        },
      },
      {
        id: 'pr',
        header: 'PR',
        width: '4.5rem',
        cell: (r: TaskRow) => {
          const pr = r.issue?.prNumber ?? null;
          if (pr === null) return <span className="text-ink-3">—</span>;
          const url = safeHttpsUrl(r.issue?.prUrl ?? null);
          return url ? (
            <ExternalLink href={url} label={`#${pr}`} />
          ) : (
            <span>#{pr}</span>
          );
        },
      },
      {
        id: 'updated',
        header: 'Updated',
        width: '6.5rem',
        align: 'end' as const,
        cell: (r: TaskRow) => <Time value={r.updatedAt} />,
      },
    ],
    [],
  );
}

/**
 * The table sits in `ScrollX`, so at 390 px it scrolls inside its own box and
 * never pushes the page sideways.
 */
export function TasksTable({ rows }: { rows: TaskRow[] }) {
  const router = useRouter();
  const columns = useColumns();
  return (
    <ScrollX label="Tasks">
      <DataTable
        rows={rows}
        getRowId={(r) => r.taskId}
        columns={columns}
        onRowActivate={(r) => router.push(taskPlannerHref(r))}
        stickyHeader={false}
        className="min-w-[56rem]"
      />
    </ScrollX>
  );
}
