'use client';

import type { WorkItem } from '@agentdock/shared';
import { workItemStatus } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { DataTable } from '@andrewbehma/glass-ui/data-table';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { Bug, ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  fleetSummary,
  phaseLabel,
  SLOT_GONE_TEXT,
} from '../../lib/board/format';
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
import {
  displayRows,
  groupWorkItems,
  type WorkDisplayRow,
} from '../../lib/work/group';
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

/** The item a row stands for: a plain row, or a slot under its group. */
const itemOf = (row: WorkDisplayRow): WorkItem | null =>
  row.type === 'group' ? null : row.item;

function StatusCell({ item }: { item: WorkItem }) {
  const status = workItemStatus(item);
  const detail = detailOf(item);
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
}

/** A group's title: the expand control, the shared title, how many slots. */
function GroupTitle({
  row,
  onToggle,
}: {
  row: Extract<WorkDisplayRow, { type: 'group' }>;
  onToggle: () => void;
}) {
  const { group, expanded } = row;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <span className="flex max-w-72 min-w-44 items-start gap-1.5 whitespace-normal">
      <Button
        variant="ghost"
        size="sm"
        icon
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} the ${group.slots.length} slots of issue #${group.issue}`}
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
      >
        <Chevron aria-hidden="true" className="size-4" />
      </Button>
      <span className="font-medium">{group.title}</span>
    </span>
  );
}

function SlotTitle({
  item,
}: {
  item: Extract<WorkDisplayRow, { type: 'slot' }>['item'];
}) {
  return (
    <span className="flex max-w-72 min-w-44 flex-col gap-0.5 whitespace-normal pl-8">
      <Link
        href={item.href}
        className="font-medium underline-offset-2 hover:underline"
        onClick={(event) => event.stopPropagation()}
        tabIndex={-1}
      >
        {fleetSummary(item.fleet)}
      </Link>
      {item.fleet.slotGone ? (
        <span>
          <Badge tone="warn" size="sm" label={SLOT_GONE_TEXT} />
        </span>
      ) : null}
    </span>
  );
}

function useColumns(toggle: (id: string) => void) {
  return useMemo(
    () => [
      {
        id: 'project',
        header: 'Project',
        width: '7.5rem',
        cell: (row: WorkDisplayRow) => {
          if (row.type === 'slot') return null;
          const { projectId, projectName } =
            row.type === 'group' ? row.group : row.item;
          return (
            <Badge
              hue={projectHue(projectId)}
              label={projectName}
              className="max-w-full truncate"
            />
          );
        },
      },
      {
        id: 'source',
        header: 'Source',
        width: '6rem',
        cell: (row: WorkDisplayRow) => {
          if (row.type === 'slot') return null;
          return (
            <Badge
              label={
                WORK_SOURCE_LABEL[
                  row.type === 'group' ? 'fleet' : row.item.source
                ]
              }
            />
          );
        },
      },
      {
        id: 'label',
        header: 'Ref',
        width: '9rem',
        cell: (row: WorkDisplayRow) => {
          if (row.type === 'group') {
            return (
              <span className="text-xs text-ink-3">
                {row.group.slots.length} slots
              </span>
            );
          }
          const r = row.item;
          return (
            <code
              className="block max-w-36 truncate text-xs text-ink-3"
              title={r.source === 'plan' ? r.planTitle : r.label}
            >
              {r.source === 'plan' ? `${r.key} · ${r.planTitle}` : r.label}
            </code>
          );
        },
      },
      {
        id: 'title',
        header: 'Title',
        cell: (row: WorkDisplayRow) => {
          if (row.type === 'group') {
            return (
              <GroupTitle row={row} onToggle={() => toggle(row.group.id)} />
            );
          }
          if (row.type === 'slot') return <SlotTitle item={row.item} />;
          const r = row.item;
          return (
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
          );
        },
      },
      {
        id: 'kind',
        header: 'Kind',
        width: '6.5rem',
        cell: (row: WorkDisplayRow) => {
          if (row.type === 'slot') return null;
          const kind =
            row.type === 'group' ? row.group.slots[0].kind : row.item.kind;
          return (
            <span className="inline-flex items-center gap-1.5">
              {kind === 'bug' ? (
                <Bug aria-hidden="true" className="size-3.5" />
              ) : (
                <Sparkles aria-hidden="true" className="size-3.5" />
              )}
              {WORK_KIND_LABEL[kind]}
            </span>
          );
        },
      },
      {
        id: 'status',
        header: 'Status',
        width: '10rem',
        cell: (row: WorkDisplayRow) =>
          row.type === 'group' ? (
            <StatusPill
              status={WORK_PILL_STATUS[row.group.status]}
              label={WORK_STATUS_LABEL[row.group.status]}
            />
          ) : (
            <StatusCell item={row.item} />
          ),
      },
      {
        id: 'issue',
        header: 'Issue',
        width: '4.5rem',
        cell: (row: WorkDisplayRow) => {
          if (row.type === 'slot') return null;
          if (row.type === 'group') {
            const first = row.group.slots[0];
            return ref(first.issueNumber ?? row.group.issue, first.issueUrl);
          }
          return issueOf(row.item);
        },
      },
      {
        id: 'pr',
        header: 'PR',
        width: '4.5rem',
        cell: (row: WorkDisplayRow) => {
          const item = itemOf(row);
          return item ? prOf(item) : null;
        },
      },
      {
        id: 'updated',
        header: 'Updated',
        width: '6.5rem',
        align: 'end' as const,
        cell: (row: WorkDisplayRow) => (
          <Time
            value={
              row.type === 'group' ? row.group.updatedAt : row.item.updatedAt
            }
          />
        ),
      },
    ],
    [toggle],
  );
}

/**
 * The table sits in `ScrollX`, so at 390 px it scrolls inside its own box and
 * never pushes the page sideways. #388: the slots of one fleet issue are one
 * row that expands into a row per slot; groups start collapsed.
 */
export function WorkTable({ rows }: { rows: WorkItem[] }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = useMemo(
    () => (id: string) =>
      setExpanded((current) => {
        const next = new Set(current);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );
  const columns = useColumns(toggle);
  const display = useMemo(
    () => displayRows(groupWorkItems(rows), expanded, workRowId),
    [rows, expanded],
  );
  return (
    <ScrollX label="Work">
      <DataTable
        rows={display}
        getRowId={(row) => row.id}
        columns={columns}
        onRowActivate={(row) =>
          row.type === 'group'
            ? toggle(row.group.id)
            : router.push(row.item.href)
        }
        stickyHeader={false}
        className="min-w-[64rem]"
      />
    </ScrollX>
  );
}
