'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Section } from '@andrewbehma/glass-ui/section';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import {
  ChevronDown,
  CircleCheck,
  CircleX,
  GitPullRequest,
  MessageSquareWarning,
  OctagonAlert,
  Settings2,
} from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useId, useState } from 'react';
import { Time } from '../../lib/format/time';
import type { NeedsYouItem } from '../../lib/overview/dashboard';
import {
  type NeedsRow,
  type NeedsRowKind,
  needsRows,
  projectsLabel,
} from '../../lib/overview/needs-rows';
import type { TerminalSetupNeed } from '../../lib/setup/format';
import { notAnswering, Retry } from './shared';
import type { useDashboard } from './use-dashboard';

/** How many waiting items the glance shows before "Show more". */
const NEEDS_YOU_SHOWN = 5;

const NEEDS_ICON: Record<NeedsYouItem['kind'], ReactNode> = {
  profile: <Settings2 aria-hidden="true" className="size-4 text-warn" />,
  failed: <CircleX aria-hidden="true" className="size-4 text-danger" />,
  blocked: <OctagonAlert aria-hidden="true" className="size-4 text-danger" />,
  prompt: (
    <MessageSquareWarning aria-hidden="true" className="size-4 text-warn" />
  ),
  approval: <GitPullRequest aria-hidden="true" className="size-4 text-ink-2" />,
};

function RowIcon({ kind }: { kind: NeedsRowKind }) {
  return kind === 'terminal-setup' ? (
    <Settings2 aria-hidden="true" className="size-4 text-warn" />
  ) : (
    NEEDS_ICON[kind]
  );
}

const ROW_LINK = 'flex items-start gap-3 rounded-md px-2 py-2 hover:bg-hover';

function SingleRow({ row }: { row: NeedsRow }) {
  const only = row.members[0];
  if (!only) return null;
  return (
    <Link href={only.href} className={ROW_LINK}>
      <span className="mt-0.5 shrink-0">
        <RowIcon kind={row.kind} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{row.title}</span>
        <span className="truncate text-xs text-ink-3">
          {only.projectName} · {only.reason}
        </span>
      </span>
      {only.since ? (
        <Time
          value={only.since}
          className="shrink-0 text-xs whitespace-nowrap text-ink-3"
        />
      ) : null}
    </Link>
  );
}

function GroupedRow({ row }: { row: NeedsRow }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
        className={`${ROW_LINK} w-full text-left`}
      >
        <span className="mt-0.5 shrink-0">
          <RowIcon kind={row.kind} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{row.title}</span>
          <span className="truncate text-xs text-ink-3">
            {projectsLabel(row.members.length)}
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`mt-0.5 size-4 shrink-0 text-ink-3 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open ? (
        <ul id={listId} className="flex flex-col pb-1 pl-9">
          {row.members.map((one) => (
            <li key={one.key}>
              <Link href={one.href} className={ROW_LINK}>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{one.projectName}</span>
                  <span className="truncate text-xs text-ink-3">
                    {one.reason}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function NeedsYouList({ rows }: { rows: NeedsRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="flex items-center gap-2 py-2 text-sm text-ink-2">
        <CircleCheck aria-hidden="true" className="size-4 text-ok" />
        Nothing is waiting on you.
      </p>
    );
  }
  return (
    <ul className="flex flex-col">
      {rows.map((row) => (
        <li key={row.key}>
          {row.members.length > 1 ? (
            <GroupedRow row={row} />
          ) : (
            <SingleRow row={row} />
          )}
        </li>
      ))}
    </ul>
  );
}

/** What waits on the person across every project, most urgent first. */
export function NeedsYou({
  facts,
  waiting,
  setup,
}: {
  facts: ReturnType<typeof useDashboard>['facts'];
  waiting: NeedsYouItem[] | undefined;
  setup: TerminalSetupNeed[];
}) {
  const [showAll, setShowAll] = useState(false);
  const rows = waiting ? needsRows(waiting, setup) : undefined;
  const shown = rows && !showAll ? rows.slice(0, NEEDS_YOU_SHOWN) : rows;
  const hidden = (rows?.length ?? 0) - (shown?.length ?? 0);

  return (
    <Section
      title="Needs you"
      description="Across every project: blocked and failed first, then prompts, approvals and setup; oldest first within each."
      pad="none"
      bodyClassName="px-2 py-1"
    >
      {shown ? (
        <>
          {facts.data && facts.data.failed.length > 0 ? (
            <p className="px-2 pt-2 text-xs text-warn">
              {notAnswering(facts.data.failed)}; what it waits on is not listed.
            </p>
          ) : null}
          <NeedsYouList rows={shown} />
          {hidden > 0 ? (
            <div className="px-2 pb-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAll(true)}
              >
                Show {hidden} more
              </Button>
            </div>
          ) : null}
        </>
      ) : facts.error !== null ? (
        <Retry title="Could not check what waits on you" section={facts} />
      ) : (
        <Skeleton className="m-2 h-24" />
      )}
    </Section>
  );
}
