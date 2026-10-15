'use client';

import type { WorkItem } from '@agentdock/shared';
import { workItemStatus } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { DataTable } from '@andrewbehma/glass-ui/data-table';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { Bug, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { phaseLabel } from '../../lib/board/format';
import { Time } from '../../lib/format/time';
import { projectHue } from '../../lib/hue';
import { safeHttpsUrl } from '../../lib/queue/format';
import { TASK_STATUS_LABEL } from '../../lib/tasks/format';
import {
  WORK_KIND_LABEL,
  WORK_PILL_STATUS,
  WORK_SOURCE_LABEL,
  WORK_STATUS_LABEL,
  workRowId,
} from '../../lib/work/format';
import { ScrollX } from '../scroll-x/scroll-x';

/** A link that leaves the row's own action alone: the row opens the item. */
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

function ref(number: number | null, url: string | null) {
  if (number === null) return <span className="text-ink-3">—</span>;
  const safe = safeHttpsUrl(url);
  return safe ? (
    <ExternalLink href={safe} label={`#${number}`} />
  ) : (
    <span>#{number}</span>
  );
}

const issueOf = (r: WorkItem) =>
  r.source === 'plan'
    ? ref(r.issue?.number ?? null, r.issue?.url ?? null)
    : ref(r.issueNumber, r.issueUrl);

const prOf = (r: WorkItem) =>
  r.source === 'plan'
    ? ref(r.issue?.prNumber ?? null, r.issue?.prUrl ?? null)
    : ref(r.prNumber, r.prUrl);

/** The pill's detail: a card's round phase, a plan task's plan or live status. */
const detailOf = (r: WorkItem): string | null => {
  if (r.source === 'plan') return TASK_STATUS_LABEL[r.nativeStatus];
  return r.roundPhase ? phaseLabel(r.roundPhase) : null;
};

function useColumns() {
  return useMemo(
    () => [
      {
        id: 'project',
        header: 'Project',
        width: '7.5rem',
        cell: (r: WorkItem) => (
          <Badge
            hue={projectHue(r.projectId)}
            label={r.projectName}
            className="max-w-full truncate"
          />
        ),
      },
      {
        id: 'source',
        header: 'Source',
        width: '6rem',
        cell: (r: WorkItem) => <Badge label={WORK_SOURCE_LABEL[r.source]} />,
      },
      {
        id: 'label',
        header: 'Ref',
        width: '9rem',
        cell: (r: WorkItem) => (
          <code
            className="block max-w-36 truncate text-xs text-ink-3"
            title={r.source === 'plan' ? r.planTitle : r.label}
          >
            {r.source === 'plan' ? `${r.key} · ${r.planTitle}` : r.label}
          </code>
        ),
      },
      {
        id: 'title',
        header: 'Title',
        cell: (r: WorkItem) => (
          <span className="block max-w-72 min-w-44 whitespace-normal">
            <Link
              href={r.href}
              className="font-medium underline-offset-2 hover:underline"
              // The row opens the item too; one activation, not two.
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
        cell: (r: WorkItem) => (
          <span className="inline-flex items-center gap-1.5">
            {r.kind === 'bug' ? (
              <Bug aria-hidden="true" className="size-3.5" />
            ) : (
              <Sparkles aria-hidden="true" className="size-3.5" />
            )}
            {WORK_KIND_LABEL[r.kind]}
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        width: '10rem',
        cell: (r: WorkItem) => {
          const status = workItemStatus(r);
          const detail = detailOf(r);
          return (
            <span className="flex flex-col items-start gap-0.5">
              <StatusPill
                status={WORK_PILL_STATUS[status]}
                label={WORK_STATUS_LABEL[status]}
              />
              {detail && detail !== WORK_STATUS_LABEL[status] ? (
                <span className="text-xs text-ink-3">{detail}</span>
              ) : null}
            </span>
          );
        },
      },
      {
        id: 'issue',
        header: 'Issue',
        width: '4.5rem',
        cell: issueOf,
      },
      {
        id: 'pr',
        header: 'PR',
        width: '4.5rem',
        cell: prOf,
      },
      {
        id: 'updated',
        header: 'Updated',
        width: '6.5rem',
        align: 'end' as const,
        cell: (r: WorkItem) => <Time value={r.updatedAt} />,
      },
    ],
    [],
  );
}

/**
 * The table sits in `ScrollX`, so at 390 px it scrolls inside its own box and
 * never pushes the page sideways.
 */
export function WorkTable({ rows }: { rows: WorkItem[] }) {
  const router = useRouter();
  const columns = useColumns();
  return (
    <ScrollX label="Work">
      <DataTable
        rows={rows}
        getRowId={workRowId}
        columns={columns}
        onRowActivate={(r) => router.push(r.href)}
        stickyHeader={false}
        className="min-w-[64rem]"
      />
    </ScrollX>
  );
}
