'use client';

import { SegmentedControl } from '@andrewbehma/glass-ui/segmented-control';
import { Kanban, List } from 'lucide-react';
import type { ReactNode } from 'react';
import { Segment } from '../../app/(app)/workflows/segment';
import { PageHeader } from '../page-header/page-header';

export interface WorkStatsValues {
  /** Workers in use, and the most the project allows. */
  workers: number;
  maxWorkers: number;
  /** Cards on the board (the shown ones while filtering). */
  cards: number;
  filtering: boolean;
  running: number;
  waiting: number;
}

const PIPS = 3;

function Divider() {
  return <span aria-hidden="true" className="h-4 w-px bg-line" />;
}

function Num({ children }: { children: ReactNode }) {
  return <b className="font-semibold text-ink tabular-nums">{children}</b>;
}

function Dot({ className }: { className: string }) {
  return (
    <span
      aria-hidden="true"
      className={`size-1.5 shrink-0 rounded-full ${className}`}
    />
  );
}

/** The Board's stats line: numbers in ink, labels in ink-3, hairline dividers. */
function WorkStats({ stats }: { stats: WorkStatsValues }) {
  const lit =
    stats.maxWorkers > 0
      ? Math.min(PIPS, Math.ceil((stats.workers / stats.maxWorkers) * PIPS))
      : 0;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-3">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className="inline-flex gap-0.5">
          {Array.from({ length: PIPS }, (_, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length decoration
              key={i}
              className={`h-2.5 w-1 rounded-full ${i < lit ? 'bg-status-running' : 'bg-line-strong'}`}
            />
          ))}
        </span>
        <span>
          <Num>{stats.workers}</Num> of <Num>{stats.maxWorkers}</Num> workers
          running
        </span>
      </span>
      <Divider />
      <span>
        <Num>{stats.cards}</Num> {stats.cards === 1 ? 'card' : 'cards'}
        {stats.filtering ? ' shown' : ''}
      </span>
      <Divider />
      <span className="inline-flex items-center gap-1.5">
        <Dot className="bg-status-running" />
        <span>
          <Num>{stats.running}</Num> running
        </span>
      </span>
      <Divider />
      <span className="inline-flex items-center gap-1.5">
        <Dot className="bg-status-waiting" />
        <span>
          <Num>{stats.waiting}</Num> waiting on you
        </span>
      </span>
    </p>
  );
}

/**
 * The Work section's header, shared by the List and the Board so switching
 * views changes only the selected segment: eyebrow, title, stats line, and an
 * action row of one 28 px height — status badge, view switch, then `children`.
 */
export function WorkHeader({
  view,
  title,
  eyebrow,
  description,
  stats,
  status,
  onSelectList,
  onSelectBoard,
  children,
}: {
  view: 'list' | 'board';
  /** "Work" across projects, "Board" inside one. */
  title: 'Work' | 'Board';
  eyebrow: string;
  description?: string;
  stats?: WorkStatsValues;
  /** The live status badge, shown only when the stream is not connected. */
  status?: ReactNode;
  onSelectList: () => void;
  onSelectBoard: () => void;
  /** Discuss and New work. */
  children?: ReactNode;
}) {
  return (
    <PageHeader
      className="mb-0"
      eyebrow={eyebrow}
      title={title}
      description={description}
      meta={stats ? <WorkStats stats={stats} /> : undefined}
      actions={
        <>
          {status}
          <SegmentedControl size="sm" aria-label={`${title} view`}>
            <Segment
              size="sm"
              layoutId="work-view"
              active={view === 'list'}
              onSelect={onSelectList}
            >
              <span className="inline-flex items-center gap-1.5">
                <List aria-hidden="true" className="size-3.5" />
                List
              </span>
            </Segment>
            <Segment
              size="sm"
              layoutId="work-view"
              active={view === 'board'}
              onSelect={onSelectBoard}
            >
              <span className="inline-flex items-center gap-1.5">
                <Kanban aria-hidden="true" className="size-3.5" />
                Board
              </span>
            </Segment>
          </SegmentedControl>
          {children}
        </>
      }
    />
  );
}
